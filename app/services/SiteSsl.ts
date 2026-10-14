/**
 * HTTPS for a site, over SSH. One phase per SSH call.
 *
 *   letsencrypt  http vhost with an ACME location (skipped if HTTPS is already on)
 *                -> certbot (webroot, auto-installed) -> https vhost
 *   custom       check the pair on the server -> install to /etc/ssl/tylix/<domain>
 *                -> https vhost
 *   none         back to the http-only vhost
 *
 * The https vhost redirects port 80 to 443 but keeps the ACME location on 80,
 * so certbot's own renewals keep working. A deploy hook reloads nginx after
 * every renewal. A rejected nginx config is rolled back to the previous one.
 *
 * The custom private key is never stored by tylix-deploy; it only travels to
 * the server inside the install script.
 *
 * NOTE: SiteProvisioner still writes the plain http vhost at site creation.
 * Re-running it on a site with HTTPS on would overwrite the https vhost.
 */

import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { sshExec } from "./Ssh.js";
import { getType } from "./SiteTypes.js";
import { shellScript, serverTarget } from "./Shell.js";

export interface SslRow {
    id: number;
    server_id: number;
    type: string;
    domain: string;
    aliases: string;
    isolated_user: string;
    php_version: string;
    port: number;
    web_directory: string;
    app_directory: string;
    build_command: string;
    ssl_mode: string;
    [key: string]: unknown;
}

export type SslRequest =
    | { mode: "none" }
    | { mode: "letsencrypt"; email: string }
    | { mode: "custom"; certificate: string; privateKey: string };

interface Phase {
    title: string;
    script: string;
}

const SSL_TIMEOUT_MS = 10 * 60_000;

const s = (value: unknown) => String(value ?? "");

function parseAliases(raw: unknown): string[] {
    try {
        const value = JSON.parse(s(raw) || "[]");
        return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    } catch {
        return [];
    }
}

// ---- nginx ----

const PROXY_HEADERS = (port: number) => `proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;`;

function locations(site: SslRow): string {
    const runtime = getType(site.type)?.runtime ?? "static";

    if (runtime === "php") {
        return `
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php${site.php_version}-fpm-${site.isolated_user}.sock;
    }`;
    }

    if (runtime === "node") {
        return `
    location / {
        ${PROXY_HEADERS(Number(site.port))}
    }`;
    }

    if (runtime === "mern") {
        return `
    location /api/ {
        ${PROXY_HEADERS(Number(site.port))}
    }

    location / {
        try_files $uri $uri/ /index.html;
    }`;
    }

    const fallback = site.type === "angular" ? "/index.html" : "=404";
    return `
    location / {
        try_files $uri $uri/ ${fallback};
    }`;
}

function common(site: SslRow, names: string): string {
    return `    server_name ${names};
    root __DOC_ROOT__;
    index index.php index.html;
    client_max_body_size 64m;

    access_log /var/log/nginx/${site.domain}-access.log;
    error_log /var/log/nginx/${site.domain}-error.log;

    location ~ /\\.(?!well-known).* {
        deny all;
    }

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
`;
}

function vhost(site: SslRow, ssl: { cert: string; key: string } | null): string {
    const names = [site.domain, ...parseAliases(site.aliases)].join(" ");

    if (!ssl) {
        return `server {
    listen 80;
    listen [::]:80;
${common(site, names)}${locations(site)}
}`;
    }

    return `server {
    listen 80;
    listen [::]:80;
    server_name ${names};

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    ssl_certificate ${ssl.cert};
    ssl_certificate_key ${ssl.key};
    ssl_protocols TLSv1.2 TLSv1.3;
${common(site, names)}${locations(site)}
}`;
}

/** Writes the vhost, tests it, rolls back on failure, reloads nginx. */
function vhostScript(site: SslRow, ssl: { cert: string; key: string } | null): string {
    return `
if command -v ufw >/dev/null 2>&1 && $SUDO ufw status | grep -q "Status: active"; then
  $SUDO ufw allow 80/tcp >/dev/null
  $SUDO ufw allow 443/tcp >/dev/null
fi
WORK="$SITE_ROOT"
if [ -n "$APP_DIR" ]; then WORK="$SITE_ROOT/$APP_DIR"; fi
DOC_ROOT="$SITE_ROOT"
if [ -n "$WEB_DIR" ]; then
  DOC_ROOT="$SITE_ROOT/$WEB_DIR"
elif [ "$AUTO_ROOT" = "1" ]; then
  for candidate in "$WORK/dist" "$WORK/build"; do
    found="$(find "$candidate" -maxdepth 4 -name index.html 2>/dev/null | head -n 1 || true)"
    if [ -n "$found" ]; then DOC_ROOT="$(dirname "$found")"; break; fi
  done
fi
echo "Web root: $DOC_ROOT"
CONF="/etc/nginx/sites-available/$DOMAIN.conf"
if [ -f "$CONF" ]; then $SUDO cp "$CONF" "$CONF.bak"; fi
cat <<'NGINX_CONF' | $SUDO tee "$CONF" >/dev/null
${vhost(site, ssl)}
NGINX_CONF
$SUDO sed -i "s#__DOC_ROOT__#$DOC_ROOT#g" "$CONF"
$SUDO ln -sf "$CONF" "/etc/nginx/sites-enabled/$DOMAIN.conf"
if ! $SUDO nginx -t >/dev/null 2>&1; then
  $SUDO nginx -t 2>&1 || true
  if [ -f "$CONF.bak" ]; then $SUDO mv "$CONF.bak" "$CONF"; fi
  echo "nginx rejected the new configuration, the previous one was restored." >&2
  exit 1
fi
$SUDO rm -f "$CONF.bak"
$SUDO systemctl reload nginx`;
}

const EXPIRY = `
END="$($SUDO openssl x509 -enddate -noout -in "$CERT_PATH" | cut -d= -f2)"
echo "TYLIX_EXPIRES=$(date -u -d "$END" +%Y-%m-%dT%H:%M:%SZ)"`;

// ---- phases ----

function baseVars(site: SslRow): Record<string, string> {
    const runtime = getType(site.type)?.runtime ?? "static";
    const autoRoot = runtime === "mern" || (runtime === "static" && s(site.build_command) !== "") ? "1" : "0";

    return {
        SITE_USER: site.isolated_user,
        SITE_ROOT: `/home/${site.isolated_user}/${site.domain}`,
        DOMAIN: site.domain,
        DOMAINS: [site.domain, ...parseAliases(site.aliases)].join(" "),
        WEB_DIR: s(site.web_directory),
        APP_DIR: s(site.app_directory),
        AUTO_ROOT: autoRoot,
    };
}

function buildPhases(site: SslRow, request: SslRequest): Phase[] {
    const base = baseVars(site);
    const httpsAlready = site.ssl_mode === "letsencrypt" || site.ssl_mode === "custom";

    if (request.mode === "none") {
        return [
            {
                title: "Switching back to HTTP",
                script: shellScript(base, vhostScript(site, null) + `\necho "HTTPS is off, serving over HTTP only"`),
            },
        ];
    }

    if (request.mode === "letsencrypt") {
        const cert = `/etc/letsencrypt/live/${site.domain}/fullchain.pem`;
        const key = `/etc/letsencrypt/live/${site.domain}/privkey.pem`;
        const phases: Phase[] = [];

        if (!httpsAlready) {
            phases.push({
                title: "Preparing nginx for the challenge",
                script: shellScript(base, `$SUDO mkdir -p /var/www/letsencrypt` + vhostScript(site, null)),
            });
        }

        phases.push({
            title: "Requesting the certificate",
            script: shellScript(
                { ...base, EMAIL: request.email },
                `
if ! command -v certbot >/dev/null 2>&1; then
  echo "Installing certbot..."
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq certbot
fi
$SUDO mkdir -p /var/www/letsencrypt
ARGS=""
for d in $DOMAINS; do ARGS="$ARGS -d $d"; done
if ! $SUDO certbot certonly --webroot -w /var/www/letsencrypt --non-interactive --agree-tos --no-eff-email --keep-until-expiring --expand -m "$EMAIL" --cert-name "$DOMAIN" $ARGS; then
  echo "Let's Encrypt couldn't issue the certificate. Check that the domain and every alias point at this server and that port 80 is open." >&2
  exit 1
fi
$SUDO mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '%s\\n' '#!/bin/sh' 'systemctl reload nginx' | $SUDO tee /etc/letsencrypt/renewal-hooks/deploy/tylix-reload-nginx.sh >/dev/null
$SUDO chmod 755 /etc/letsencrypt/renewal-hooks/deploy/tylix-reload-nginx.sh
echo "Certificate issued. Certbot renews it automatically."`,
            ),
        });

        phases.push({
            title: "Enabling HTTPS",
            script: shellScript(
                { ...base, CERT_PATH: cert },
                vhostScript(site, { cert, key }) + EXPIRY + `\necho "HTTPS enabled for $DOMAIN"`,
            ),
        });

        return phases;
    }

    // custom
    const dir = `/etc/ssl/tylix/${site.domain}`;
    const cert = `${dir}/fullchain.pem`;
    const key = `${dir}/privkey.pem`;

    return [
        {
            title: "Checking the certificate and key",
            script: shellScript(
                {
                    ...base,
                    CERT_B64: Buffer.from(request.certificate, "utf8").toString("base64"),
                    KEY_B64: Buffer.from(request.privateKey, "utf8").toString("base64"),
                    DIR: dir,
                },
                `
command -v openssl >/dev/null 2>&1 || { echo "openssl isn't installed on this server." >&2; exit 1; }
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
printf %s "$CERT_B64" | base64 -d > "$TMP/fullchain.pem"
printf %s "$KEY_B64" | base64 -d > "$TMP/privkey.pem"
chmod 600 "$TMP/privkey.pem"
openssl x509 -in "$TMP/fullchain.pem" -noout >/dev/null 2>&1 || { echo "The certificate isn't valid PEM." >&2; exit 1; }
openssl pkey -in "$TMP/privkey.pem" -noout -passin pass: >/dev/null 2>&1 || { echo "The private key is invalid or passphrase-protected." >&2; exit 1; }
CERT_PUB="$(openssl x509 -in "$TMP/fullchain.pem" -noout -pubkey | openssl md5)"
KEY_PUB="$(openssl pkey -in "$TMP/privkey.pem" -pubout | openssl md5)"
[ "$CERT_PUB" = "$KEY_PUB" ] || { echo "The private key doesn't match the certificate." >&2; exit 1; }
openssl x509 -in "$TMP/fullchain.pem" -noout -checkend 0 >/dev/null || { echo "The certificate has expired." >&2; exit 1; }
if ! openssl x509 -in "$TMP/fullchain.pem" -noout -checkhost "$DOMAIN" 2>/dev/null | grep -q "does match"; then
  echo "WARNING: the certificate doesn't list $DOMAIN. Browsers will show a warning."
fi
$SUDO mkdir -p "$DIR"
$SUDO install -m 644 "$TMP/fullchain.pem" "$DIR/fullchain.pem"
$SUDO install -m 600 "$TMP/privkey.pem" "$DIR/privkey.pem"
echo "Installed under $DIR"`,
            ),
        },
        {
            title: "Enabling HTTPS",
            script: shellScript(
                { ...base, CERT_PATH: cert },
                vhostScript(site, { cert, key }) + EXPIRY + `\necho "HTTPS enabled for $DOMAIN"`,
            ),
        },
    ];
}

function lastLine(stderr: string, stdout: string): string {
    const text = stderr.trim() || stdout.trim();
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    return (lines[lines.length - 1] ?? "Command failed.").slice(0, 300);
}

export class SiteSsl {
    /** Fire and forget. run() never throws; failures are saved on the row. */
    static start(siteId: number, request: SslRequest): void {
        void SiteSsl.run(siteId, request);
    }

    static async run(siteId: number, request: SslRequest): Promise<void> {
        let log = "";

        try {
            const site = (await Site.find(siteId)) as SslRow | null;
            if (!site) return;

            const server = (await Server.find(site.server_id)) as
                | { host: string; port: number; ssh_user: string; ssh_key: string }
                | null;
            if (!server) throw new Error("The server no longer exists.");

            const target = serverTarget(server);
            let expires = "";

            await Site.update(siteId, { ssl_status: "working", ssl_error: "", ssl_log: "" });

            for (const phase of buildPhases(site, request)) {
                log += `==> ${phase.title}\n`;
                await Site.update(siteId, { ssl_log: log });

                const result = await sshExec(target, phase.script, SSL_TIMEOUT_MS);
                const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
                if (out) log += out + "\n";
                log += "\n";
                await Site.update(siteId, { ssl_log: log });

                const match = /TYLIX_EXPIRES=(\S+)/.exec(result.stdout);
                if (match) expires = match[1];

                if (result.code !== 0) {
                    throw new Error(lastLine(result.stderr, result.stdout));
                }
            }

            await Site.update(siteId, {
                ssl_mode: request.mode,
                ssl_status: request.mode === "none" ? "idle" : "active",
                ssl_error: "",
                ssl_log: log,
                ssl_expires_at: request.mode === "none" ? "" : expires,
                ssl_email: request.mode === "letsencrypt" ? request.email : s(site.ssl_email),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : "SSL setup failed.";
            log += `\nFAILED: ${message}\n`;
            await Site.update(siteId, { ssl_status: "failed", ssl_error: message.slice(0, 500), ssl_log: log });
        }
    }
}