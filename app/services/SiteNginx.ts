/**
 * Reads and writes a site's nginx config over SSH, for the editor in Site settings.
 *
 * write() never leaves a broken config behind: the current file is copied to
 * /etc/nginx/tylix-backups/<domain>.conf.bak first, the new content is written,
 * and `nginx -t` must pass before nginx is reloaded. If the test fails, the
 * backup is put back and NginxRejected is thrown with nginx's own message.
 */

import { Server } from "../models/Server.js";
import { sshExec } from "./Ssh.js";
import { shellScript, serverTarget } from "./Shell.js";

export const MAX_NGINX_BYTES = 50_000;

const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;

/** nginx -t refused the new config; the previous one was restored. */
export class NginxRejected extends Error {}

export interface NginxSite {
    id: number;
    server_id: number;
    domain: string;
    isolated_user: string;
    [key: string]: unknown;
}

export const nginxPathFor = (domain: string) => `/etc/nginx/sites-available/${domain}.conf`;

async function targetFor(site: NginxSite) {
    const server = await Server.find(site.server_id);
    if (!server) throw new Error("The server no longer exists.");
    return serverTarget(server as never);
}

function lastLine(stderr: string, stdout: string): string {
    const text = stderr.trim() || stdout.trim();
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    return (lines[lines.length - 1] ?? "Command failed.").slice(0, 300);
}

export const SiteNginx = {
    async read(site: NginxSite): Promise<string> {
        const target = await targetFor(site);

        const script = shellScript(
            { DOMAIN: site.domain, SITE_USER: site.isolated_user },
            `
CONF="/etc/nginx/sites-available/$DOMAIN.conf"
[ -f "$CONF" ] || { echo "The nginx config $CONF was not found on the server." >&2; exit 1; }
$SUDO cat "$CONF"`,
        );

        const result = await sshExec(target, script, READ_TIMEOUT_MS);
        if (result.code !== 0) throw new Error(lastLine(result.stderr, result.stdout));

        return String(result.stdout ?? "");
    },

    async write(site: NginxSite, content: string): Promise<void> {
        const target = await targetFor(site);

        const script = shellScript(
            {
                DOMAIN: site.domain,
                SITE_USER: site.isolated_user,
                NGINX_B64: Buffer.from(content, "utf8").toString("base64"),
            },
            `
CONF="/etc/nginx/sites-available/$DOMAIN.conf"
[ -f "$CONF" ] || { echo "The nginx config $CONF was not found on the server." >&2; exit 1; }

BACKUP_DIR="/etc/nginx/tylix-backups"
BACKUP="$BACKUP_DIR/$DOMAIN.conf.bak"
$SUDO mkdir -p "$BACKUP_DIR"

TMP="$(mktemp)"
printf '%s' "$NGINX_B64" | base64 -d > "$TMP"

$SUDO cp -p "$CONF" "$BACKUP"
$SUDO cp "$TMP" "$CONF"
rm -f "$TMP"

if ! OUT="$($SUDO nginx -t 2>&1)"; then
  $SUDO cp -p "$BACKUP" "$CONF"
  echo "$OUT" >&2
  echo "nginx rejected the config, so your previous version was restored." >&2
  exit 3
fi

$SUDO systemctl reload nginx
echo "nginx reloaded"`,
        );

        const result = await sshExec(target, script, WRITE_TIMEOUT_MS);

        if (result.code === 3) {
            throw new NginxRejected(String(result.stderr ?? "").trim().slice(-4000));
        }
        if (result.code !== 0) {
            throw new Error(lastLine(result.stderr, result.stdout));
        }
    },
};