/**
 * Deletes a site and everything SiteProvisioner created for it, then its record.
 *
 * Runs in the background (same shape as SiteProvisioner / SiteDeployer):
 *   SiteDestroyer.start(siteId, force)
 *
 * What the provisioner creates, and the step that removes it:
 *   del_services   systemd unit app-<user> (node and mern sites)
 *   del_webserver  /etc/nginx/sites-available|enabled/<domain>.conf and the
 *                  <domain>-access/error logs, then nginx -t + reload
 *   del_php        /etc/php/<ver>/fpm/pool.d/<user>.conf, then reload php-fpm
 *   del_ssl        the Let's Encrypt certificate for <domain>
 *   del_database   wp_<user> database + its MySQL user (WordPress sites)
 *   del_user       the isolated unix user and /home/<user> (site files, the
 *                  .run-<user>.sh runner and the git checkout live in there)
 *
 * Every step tolerates "already gone", so a retry after a partial failure is
 * safe. Each step is its own SSH call so the log shows where it stopped.
 *
 * On failure the site goes to status "delete_failed" with the reason in
 * `error`. `force` skips all server cleanup and only removes the record, for
 * servers that no longer exist or can't be reached.
 *
 * Every value that reaches a shell is re-validated here, even though
 * SiteValidator already checked it when the site was created.
 */

import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { sshExec } from "./Ssh.js";
import { serverTarget } from "./Shell.js";

interface SiteRow {
    id: number;
    server_id: number;
    type: string;
    domain: string;
    isolated_user: string;
    log: string;
}

interface ServerRow {
    id: number;
    ssh_user: string;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const USER = /^[a-z][a-z0-9_-]{0,31}$/;
// "www" is here because the default PHP-FPM pool is www.conf and must never be matched.
const RESERVED_USERS = ["root", "www", "www-data", "nginx", "ubuntu", "admin", "tylix", "mysql", "postgres", "redis"];
const LOG_MARK = "\n\n--- Delete ";

/** Stops and removes the app's systemd unit. */
const SERVICES = String.raw`
[ -n "$U" ] || exit 1
for n in "app-$U.service"; do
  if [ -f "/etc/systemd/system/$n" ]; then
    systemctl stop "$n" >/dev/null 2>&1 || true
    systemctl disable "$n" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$n"
    echo "removed unit $n"
  fi
done
for f in $(grep -lsE -e "^User=$U\$" /etc/systemd/system/*.service 2>/dev/null); do
  n=$(basename "$f")
  systemctl stop "$n" >/dev/null 2>&1 || true
  systemctl disable "$n" >/dev/null 2>&1 || true
  rm -f "$f"
  echo "removed unit $n"
done
systemctl daemon-reload >/dev/null 2>&1 || true
systemctl reset-failed >/dev/null 2>&1 || true
exit 0
`;

/** Removes the nginx site and reloads. A failing nginx -t is a real failure: it must not be left broken. */
const WEBSERVER = String.raw`
[ -n "$U" ] && [ -n "$D" ] || exit 1
rm -f "/etc/nginx/sites-enabled/$D.conf" "/etc/nginx/sites-available/$D.conf"
rm -f "/var/log/nginx/$D-access.log" "/var/log/nginx/$D-error.log"
for f in $(grep -lsF -e "/home/$U/" /etc/nginx/sites-enabled/* /etc/nginx/sites-available/* 2>/dev/null); do
  rm -f "$f"
  echo "removed nginx file $f"
done
if command -v nginx >/dev/null 2>&1; then
  nginx -t 2>&1 && systemctl reload nginx 2>&1
fi
`;

/** Removes the PHP-FPM pool the provisioner wrote (pool.d/<user>.conf) and reloads that PHP version. */
const PHP = String.raw`
[ -n "$U" ] || exit 1
for f in /etc/php/*/fpm/pool.d/"$U".conf; do
  [ -f "$f" ] || continue
  ver=$(echo "$f" | cut -d/ -f4)
  rm -f "$f"
  echo "removed php-fpm pool $f"
  systemctl reload "php$ver-fpm" >/dev/null 2>&1 || systemctl restart "php$ver-fpm" >/dev/null 2>&1 || true
done
exit 0
`;

/** Deletes the Let's Encrypt certificate for the domain, if there is one. */
const SSL = String.raw`
[ -n "$D" ] || exit 1
if command -v certbot >/dev/null 2>&1; then
  certbot delete --cert-name "$D" --non-interactive 2>&1 || true
else
  echo "certbot not installed, skipping"
fi
exit 0
`;

/**
 * Drops the WordPress database and its user, using the same naming as the
 * provisioner: wp_<user with - turned into _>, and the user is wp_ plus the
 * first 28 characters of that. Both names are only [a-z0-9_], so no quoting.
 */
const DATABASE = String.raw`
[ -n "$U" ] || exit 1
if ! command -v mysql >/dev/null 2>&1; then
  echo "mysql not installed, skipping"
  exit 0
fi
SAFE=$(printf %s "$U" | tr '-' '_')
DB_NAME="wp_$SAFE"
DB_USER="wp_$(printf %s "$SAFE" | cut -c1-28)"
mysql -e "DROP DATABASE IF EXISTS $DB_NAME; DROP USER IF EXISTS '$DB_USER'@'localhost'; FLUSH PRIVILEGES;" 2>&1
echo "dropped database $DB_NAME and user $DB_USER"
`;

/** Removes the isolated user and its files. Refuses to touch system accounts. */
const USER_STEP = String.raw`
[ -n "$U" ] || exit 1
if id "$U" >/dev/null 2>&1; then
  UIDN=$(id -u "$U")
  if [ "$UIDN" -lt 1000 ]; then
    echo "refusing to remove $U: it is a system account"
    exit 3
  fi
  pkill -KILL -u "$U" >/dev/null 2>&1 || true
  crontab -r -u "$U" >/dev/null 2>&1 || true
  sleep 1
  userdel -r "$U" 2>&1 || true
fi
rm -rf "/home/$U"
if getent group "$U" >/dev/null 2>&1; then
  groupdel "$U" >/dev/null 2>&1 || true
fi
if id "$U" >/dev/null 2>&1; then
  echo "could not remove user $U"
  exit 1
fi
echo "removed user $U and /home/$U"
`;

/** Single-quotes a string for safe use inside `bash -c`. */
function shq(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function asRoot(sshUser: string, vars: string, body: string): string {
    const full = `${vars}\n${body}`;
    return sshUser === "root" ? `bash -c ${shq(full)}` : `sudo -n bash -c ${shq(full)}`;
}

function tail(text: string, max = 1500): string {
    const clean = text.trim();
    return clean.length > max ? "…" + clean.slice(-max) : clean;
}

interface Step {
    step: string;
    label: string;
    script: string;
    timeoutMs: number;
    run: boolean;
}

export class SiteDestroyer {
    static start(siteId: number, force = false): void {
        SiteDestroyer.run(siteId, force).catch(async () => {
            try {
                await Site.update(siteId, {
                    status: "delete_failed",
                    error: "Something went wrong while deleting this site.",
                });
            } catch {
                // nothing more we can do
            }
        });
    }

    private static async run(siteId: number, force: boolean): Promise<void> {
        const site = (await Site.find(siteId)) as SiteRow | null;
        if (!site) return;

        const base = String(site.log ?? "").split(LOG_MARK)[0];
        const lines: string[] = [];
        const say = (message: string) => lines.push(message);

        const save = (patch: Record<string, unknown>) =>
            Site.update(site.id, {
                ...patch,
                log: `${base}${LOG_MARK}${new Date().toISOString()} ---\n${lines.join("\n")}`,
            });

        const fail = async (message: string) => {
            say(`FAILED: ${message}`);
            await save({ status: "delete_failed", error: message });
        };

        if (force) {
            say("Forced delete: skipping server cleanup, removing the record only.");
        } else {
            const server = (await Server.find(site.server_id)) as ServerRow | null;

            if (!server) {
                say("The server record no longer exists, so there is nothing to clean up.");
            } else {
                const domain = String(site.domain || "");
                const user = String(site.isolated_user || "");

                if (!DOMAIN.test(domain) || !USER.test(user) || RESERVED_USERS.includes(user)) {
                    return fail('The stored domain or user looks invalid, so server cleanup was refused. Use "Delete anyway" to remove just the record.');
                }

                if (user === server.ssh_user) {
                    return fail('This site\'s isolated user is the same as the server\'s SSH user, so server cleanup was refused. Use "Delete anyway" to remove just the record.');
                }

                let target: ReturnType<typeof serverTarget>;
                try {
                    target = serverTarget(server as never);
                } catch {
                    return fail("Couldn't read the stored SSH key for this server.");
                }

                const vars = `U='${user}'; D='${domain}';`;

                const steps: Step[] = [
                    { step: "del_services", label: "Stopping the app", script: SERVICES, timeoutMs: 45_000, run: true },
                    { step: "del_webserver", label: "Removing the nginx site", script: WEBSERVER, timeoutMs: 45_000, run: true },
                    { step: "del_php", label: "Removing the PHP pool", script: PHP, timeoutMs: 45_000, run: true },
                    { step: "del_ssl", label: "Removing the certificate", script: SSL, timeoutMs: 60_000, run: true },
                    { step: "del_database", label: "Removing the database", script: DATABASE, timeoutMs: 45_000, run: site.type === "wordpress" },
                    { step: "del_user", label: "Removing the user and files", script: USER_STEP, timeoutMs: 90_000, run: true },
                ];

                for (const s of steps) {
                    if (!s.run) continue;

                    await save({ step: s.step });
                    say(`[${s.label}]`);

                    const result = await sshExec(target, asRoot(server.ssh_user, vars, s.script), s.timeoutMs);
                    const output = tail(`${result.stdout}\n${result.stderr}`);
                    if (output) say(output);

                    if (result.code === 255) {
                        return fail('Couldn\'t reach the server over SSH. If the server is gone, use "Delete anyway".');
                    }

                    if (result.code !== 0) {
                        return fail(`"${s.label}" failed (exit ${result.code}). Check the log, then retry or use "Delete anyway".`);
                    }
                }
            }
        }

        say("Removing the site record.");
        await Site.delete(site.id);
    }
}