/**
 * Creates a site on a server over SSH, one phase per SSH call so the UI can
 * show real progress. Steps, in order (each only when it applies):
 *
 *   user       isolated unix user + /home/<user>/<domain>
 *   clone      git clone from GitHub or GitLab
 *   wordpress  download WordPress (wordpress type only)
 *   database   MySQL database + wp-config.php (wordpress type only)
 *   install    composer install / npm install (python, java, go, ruby, dotnet
 *              and rust: toolchain check only)
 *   build      npm build (angular, mern client, tylix, nextjs)
 *   service    systemd unit running the app (node, mern, python, java, go, ruby,
 *              dotnet and rust types). Node apps are started now; the others are
 *              built and started by the first deploy.
 *   webserver  php-fpm pool (php types) + nginx vhost, tested before reload
 *
 * Every script is idempotent, so a failed site can be re-run later.
 *
 * The server and the source control connection must belong to the same team
 * as the site, like in SiteDeployer.
 *
 * ASSUMPTION: sshExec(server, script) runs `script` through `bash -s` as the
 * server's ssh_user and resolves with { code, stdout, stderr }. The ssh user
 * is root or has passwordless sudo.
 */

import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { CryptoService } from "./CryptoService.js";
import { sshExec } from "./Ssh.js";
import { getType, isPhp, isAppRuntime, isSpa } from "./SiteTypes.js";
import { serverTarget } from "./Shell.js";
import { teamIdOfRow } from "./TeamScope.js";

interface SiteRow {
    id: number;
    user_id: number;
    team_id: number | null;
    server_id: number;
    source_control_id: number;
    type: string;
    domain: string;
    aliases: string;
    isolated_user: string;
    php_version: string;
    port: number;
    repository: string;
    branch: string;
    web_directory: string;
    app_directory: string;
    backend_directory: string;
    build_command: string;
    start_command: string;
    install_deps: number | boolean;
    [key: string]: unknown;
}

interface ServerRow {
    user_id: number;
    team_id: number | null;
    [key: string]: unknown;
}

interface Source {
    kind: string;
    token: string;
}

interface Phase {
    step: string;
    title: string;
    script: string;
}

const s = (value: unknown) => String(value ?? "");

/** Single-quotes a value for bash. Values are validated too; this is the second lock. */
const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const FUNCTIONS = `
set -eu
export DEBIAN_FRONTEND=noninteractive
SUDO=""
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

as_user() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$SITE_USER" -- env HOME="/home/$SITE_USER" "$@"
  else
    sudo -u "$SITE_USER" env HOME="/home/$SITE_USER" "$@"
  fi
}
`;

function script(vars: Record<string, string>, body: string): string {
    const lines = Object.entries(vars).map(([key, value]) => `${key}=${q(value)}`);
    return lines.join("\n") + "\n" + FUNCTIONS + "\n" + body + "\n";
}

// ---- reusable bash snippets (no backslashes or backticks on purpose) ----

/** Sets WORK to the app folder (APP_DIR, or the site root) and requires it to exist. */
const APP_WORK = `
WORK="$SITE_ROOT"
if [ -n "$APP_DIR" ]; then WORK="$SITE_ROOT/$APP_DIR"; fi
[ -d "$WORK" ] || { echo "Folder '$APP_DIR' was not found in the repository." >&2; exit 1; }`;

/** Same, for the MERN backend folder. */
const BACKEND_WORK = `
WORK="$SITE_ROOT"
if [ -n "$BACKEND_DIR" ]; then WORK="$SITE_ROOT/$BACKEND_DIR"; fi
[ -d "$WORK" ] || { echo "Folder '$BACKEND_DIR' was not found in the repository." >&2; exit 1; }`;

const NPM_INSTALL = `
cd "$WORK"
if [ ! -f package.json ]; then
  echo "No package.json in $WORK, skipping npm install."
else
  command -v npm >/dev/null 2>&1 || { echo "npm isn't installed on this server." >&2; exit 1; }
  if [ -f package-lock.json ]; then
    as_user npm ci
  else
    as_user npm install
  fi
fi`;

const RUN_BUILD = `
cd "$WORK"
if [ ! -f package.json ]; then
  echo "No package.json in $WORK, skipping build."
elif [ -n "$BUILD_COMMAND" ]; then
  echo "Running: $BUILD_COMMAND"
  as_user bash -c 'cd "$1" && eval "$2"' _ "$WORK" "$BUILD_COMMAND"
fi`;

// ---- nginx ----

function parseAliases(raw: string): string[] {
    try {
        const value = JSON.parse(raw || "[]");
        return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    } catch {
        return [];
    }
}

const PROXY_HEADERS = (port: number) => `proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;`;

/** The root is a placeholder; the script fills in the real folder (it may be auto-detected). */
function vhost(site: SiteRow, aliases: string[]): string {
    const names = [site.domain, ...aliases].join(" ");
    const runtime = getType(site.type)?.runtime ?? "static";

    const head = `server {
    listen 80;
    listen [::]:80;
    server_name ${names};
    root __DOC_ROOT__;
    index index.php index.html;
    client_max_body_size 64m;

    access_log /var/log/nginx/${site.domain}-access.log;
    error_log /var/log/nginx/${site.domain}-error.log;

    location ~ /\\.(?!well-known).* {
        deny all;
    }
`;

    if (runtime === "php") {
        return (
            head +
            `
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php${site.php_version}-fpm-${site.isolated_user}.sock;
    }
}`
        );
    }

    // Every runtime that runs one process on a port (mern is handled below: its API lives under /api/).
    if (isAppRuntime(runtime) && runtime !== "mern") {
        // Django collects static files into web_directory (STATIC_ROOT); nginx serves them directly.
        const statics =
            site.type === "django" && s(site.web_directory) !== ""
                ? `
    location /static/ {
        alias __DOC_ROOT__/;
        expires 30d;
        access_log off;
    }
`
                : "";

        return (
            head +
            statics +
            `
    location / {
        ${PROXY_HEADERS(Number(site.port))}
    }
}`
        );
    }

    if (runtime === "mern") {
        return (
            head +
            `
    location /api/ {
        ${PROXY_HEADERS(Number(site.port))}
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}`
        );
    }

    // static: angular is a single-page app, so unknown paths fall back to index.html
    const fallback = isSpa(site.type) ? "/index.html" : "=404";
    return (
        head +
        `
    location / {
        try_files $uri $uri/ ${fallback};
    }
}`
    );
}

function phpPool(site: SiteRow): string {
    return `[${site.isolated_user}]
user = ${site.isolated_user}
group = ${site.isolated_user}
listen = /run/php/php${site.php_version}-fpm-${site.isolated_user}.sock
listen.owner = www-data
listen.group = www-data
pm = ondemand
pm.max_children = 10
pm.process_idle_timeout = 10s`;
}

/** Toolchains checked at creation time for runtimes that are built by the first deploy. */
const TOOLCHAINS: Record<string, { label: string; check: string; show: string }> = {
    go: { label: "Go", check: "command -v go", show: "go version" },
    ruby: { label: "Ruby and Bundler", check: "command -v ruby && command -v bundle", show: "ruby --version" },
    dotnet: { label: "the .NET SDK", check: "command -v dotnet", show: "dotnet --list-sdks | head -n 1" },
    rust: { label: "Rust", check: "command -v cargo && command -v rustc", show: "cargo --version" },
};

/**
 * Extra lines for the app's systemd [Service] section.
 * go, rust, ruby and dotnet have no dotenv convention, so systemd loads the
 * site's .env for them (the leading "-" makes a missing file harmless; the
 * first deploy writes it).
 */
const UNIT_ENV: Record<string, string> = {
    node: "Environment=NODE_ENV=production",
    mern: "Environment=NODE_ENV=production",
    python: "Environment=PYTHONUNBUFFERED=1",
    java: "SuccessExitStatus=143",
    go: "EnvironmentFile=-$WORK/.env",
    rust: "EnvironmentFile=-$WORK/.env",
    ruby: "EnvironmentFile=-$WORK/.env\nEnvironment=RAILS_ENV=production\nEnvironment=RACK_ENV=production",
    dotnet: "EnvironmentFile=-$WORK/.env\nEnvironment=DOTNET_ENVIRONMENT=Production\nEnvironment=ASPNETCORE_ENVIRONMENT=Production",
};

// ---- phases ----

function buildPhases(site: SiteRow, source: Source | null): Phase[] {
    const info = getType(site.type);
    const runtime = info?.runtime ?? "static";
    const root = `/home/${site.isolated_user}/${site.domain}`;
    const aliases = parseAliases(site.aliases);

    const base: Record<string, string> = {
        SITE_USER: site.isolated_user,
        SITE_ROOT: root,
        DOMAIN: site.domain,
        PHP_VERSION: s(site.php_version),
        APP_DIR: s(site.app_directory),
        BACKEND_DIR: s(site.backend_directory),
        WEB_DIR: s(site.web_directory),
        BUILD_COMMAND: s(site.build_command),
        START_COMMAND: s(site.start_command),
        PORT: String(Number(site.port) || 0),
    };

    const hasRepo =
        Boolean(source) && Number(site.source_control_id) !== 0 && s(site.repository) !== "" && info?.usesRepository !== false;
    const doInstall = hasRepo && Boolean(site.install_deps);
    const phases: Phase[] = [];

    phases.push({
        step: "user",
        title: "Creating user and folders",
        script: script(
            base,
            `
if ! id "$SITE_USER" >/dev/null 2>&1; then
  $SUDO useradd -m -s /bin/bash "$SITE_USER"
fi
$SUDO chmod 711 "/home/$SITE_USER"
$SUDO mkdir -p "$SITE_ROOT"
$SUDO chown -R "$SITE_USER:$SITE_USER" "/home/$SITE_USER"
echo "Site folder ready at $SITE_ROOT"`,
        ),
    });

    if (hasRepo && source) {
        const host = source.kind === "gitlab" ? "gitlab.com" : "github.com";
        const user = source.kind === "gitlab" ? "oauth2" : "x-access-token";
        phases.push({
            step: "clone",
            title: "Cloning repository",
            script: script(
                {
                    ...base,
                    BRANCH: s(site.branch),
                    CLONE_URL: `https://${user}:${source.token}@${host}/${site.repository}.git`,
                    PUBLIC_URL: `https://${host}/${site.repository}.git`,
                },
                `
if [ -d "$SITE_ROOT/.git" ]; then
  echo "Repository already cloned."
  exit 0
fi
as_user env GIT_TERMINAL_PROMPT=0 git clone --branch "$BRANCH" --single-branch "$CLONE_URL" "$SITE_ROOT"
as_user git -C "$SITE_ROOT" remote set-url origin "$PUBLIC_URL"
echo "Cloned ${site.repository} (${site.branch})"`,
            ),
        });
    }

    if (site.type === "wordpress") {
        phases.push({
            step: "wordpress",
            title: "Downloading WordPress",
            script: script(
                base,
                `
cd "$SITE_ROOT"
if [ -f wp-load.php ]; then
  echo "WordPress files already present."
  exit 0
fi
command -v curl >/dev/null 2>&1 || { echo "curl isn't installed on this server." >&2; exit 1; }
TMP="$(mktemp -d)"
curl -fsSL https://wordpress.org/latest.tar.gz -o "$TMP/wp.tar.gz"
tar -xzf "$TMP/wp.tar.gz" -C "$TMP"
$SUDO cp -a "$TMP/wordpress/." "$SITE_ROOT/"
$SUDO chown -R "$SITE_USER:$SITE_USER" "$SITE_ROOT"
rm -rf "$TMP"
echo "WordPress downloaded"`,
            ),
        });

        phases.push({
            step: "database",
            title: "Creating the WordPress database",
            script: script(
                base,
                `
cd "$SITE_ROOT"
if [ -f wp-config.php ]; then
  echo "wp-config.php already exists."
  exit 0
fi
if ! command -v mysql >/dev/null 2>&1; then
  echo "MySQL isn't installed on this server. Enter the database details in the WordPress installer."
  exit 0
fi
[ -f wp-config-sample.php ] || { echo "wp-config-sample.php is missing." >&2; exit 1; }
SAFE="$(printf %s "$SITE_USER" | tr '-' '_')"
DB_NAME="wp_$SAFE"
DB_USER="wp_$(printf %s "$SAFE" | cut -c1-28)"
DB_PASS="$(openssl rand -hex 16)"
$SUDO mysql <<SQL
CREATE DATABASE IF NOT EXISTS $DB_NAME CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON $DB_NAME.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
as_user cp wp-config-sample.php wp-config.php
as_user sed -i "s/database_name_here/$DB_NAME/; s/username_here/$DB_USER/; s/password_here/$DB_PASS/" wp-config.php
while grep -q 'put your unique phrase here' wp-config.php; do
  as_user sed -i "0,/put your unique phrase here/s//$(openssl rand -hex 32)/" wp-config.php
done
echo "Database $DB_NAME ready and wp-config.php written"`,
            ),
        });
    }

    // ---- python / java / go / ruby / dotnet / rust: only check the runtime here.
    // The first deploy does the virtualenv, pip, bundle and build work, because
    // that needs the .env to exist. ----

    if (runtime === "python" && hasRepo) {
        phases.push({
            step: "install",
            title: "Checking Python",
            script: script(
                base,
                `
command -v python3 >/dev/null 2>&1 && python3 -c 'import venv, ensurepip' 2>/dev/null || { echo "Python 3 with venv isn't installed on this server. Install it from the Packages page, then create the site again." >&2; exit 1; }
echo "$(python3 --version) is available"`,
            ),
        });
    }

    if (runtime === "java" && hasRepo) {
        phases.push({
            step: "install",
            title: "Checking Java",
            script: script(
                base,
                `
command -v java >/dev/null 2>&1 && command -v javac >/dev/null 2>&1 || { echo "The JDK isn't installed on this server. Install Java from the Packages page, then create the site again." >&2; exit 1; }
java -version 2>&1 | head -n 1`,
            ),
        });
    }

    const tool = TOOLCHAINS[runtime];

    if (tool && hasRepo) {
        phases.push({
            step: "install",
            title: `Checking ${tool.label}`,
            script: script(
                base,
                `
if ! ( ${tool.check} ) >/dev/null 2>&1; then
  echo "${tool.label} isn't installed on this server. Install it from the Packages page, then create the site again." >&2
  exit 1
fi
${tool.show}`,
            ),
        });
    }

    // ---- install / build ----

    if (isPhp(site.type) && site.type !== "wordpress" && doInstall) {
        phases.push({
            step: "install",
            title: "Running composer install",
            script: script(
                { ...base, IS_LARAVEL: site.type === "laravel" ? "1" : "0" },
                `
cd "$SITE_ROOT"
if [ ! -f composer.json ]; then
  echo "No composer.json found, skipping."
else
  command -v composer >/dev/null 2>&1 || { echo "Composer isn't installed on this server." >&2; exit 1; }
  command -v "php$PHP_VERSION" >/dev/null 2>&1 || { echo "PHP $PHP_VERSION isn't installed on this server." >&2; exit 1; }
  as_user "php$PHP_VERSION" "$(command -v composer)" install --no-dev --no-interaction --prefer-dist --optimize-autoloader
  if [ "$IS_LARAVEL" = "1" ] && [ -f artisan ]; then
    if [ ! -f .env ] && [ -f .env.example ]; then as_user cp .env.example .env; fi
    if [ -f .env ] && ! grep -Eq '^APP_KEY=.+' .env; then as_user "php$PHP_VERSION" artisan key:generate --force; fi
  fi
fi`,
            ),
        });
    }

    if ((runtime === "node" || runtime === "static") && hasRepo) {
        if (doInstall) {
            phases.push({
                step: "install",
                title: "Running npm install",
                script: script(base, APP_WORK + "\n" + NPM_INSTALL),
            });
        }
        if (s(site.build_command) !== "") {
            phases.push({
                step: "build",
                title: "Building the app",
                script: script(base, APP_WORK + "\n" + RUN_BUILD),
            });
        }
    }

    if (runtime === "mern" && hasRepo) {
        if (doInstall) {
            phases.push({
                step: "install",
                title: "Installing the API dependencies",
                script: script(base, BACKEND_WORK + "\n" + NPM_INSTALL),
            });
        }
        phases.push({
            step: "build",
            title: "Building the client",
            script: script(base, APP_WORK + "\n" + (doInstall ? NPM_INSTALL + "\n" : "") + RUN_BUILD),
        });
    }

    // ---- app service (node, mern, python, java, go, ruby, dotnet, rust) ----

    const appRuntime = isAppRuntime(runtime);

    if (appRuntime && hasRepo && s(site.start_command) !== "") {
        const workSnippet = runtime === "mern" ? BACKEND_WORK : APP_WORK;
        // Only node and mern apps are ready to run now. The others aren't built yet,
        // so the unit is enabled but not started; the first deploy builds the app
        // and starts it.
        const startNow = runtime === "node" || runtime === "mern";
        const extraUnit = [UNIT_ENV[runtime] ?? "", site.type === "nuxt" ? "EnvironmentFile=-$WORK/.env" : ""]
            .filter(Boolean)
            .join("\n");

        const afterEnable = startNow
            ? `$SUDO systemctl restart "$UNIT"
sleep 3
if $SUDO systemctl is-active --quiet "$UNIT"; then
  echo "App is running on port $PORT"
else
  echo "WARNING: the app did not stay up. Last log lines:"
  $SUDO journalctl -u "$UNIT" -n 15 --no-pager || true
fi`
            : `echo "Service $UNIT created. It starts after the first deploy (add your .env on the Deployment tab first)."`;

        phases.push({
            step: "service",
            title: startNow ? "Starting the app" : "Creating the app service",
            script: script(
                base,
                `
${workSnippet}
UNIT="app-$SITE_USER"
RUNNER="/home/$SITE_USER/.run-$SITE_USER.sh"
{
  printf '%s\\n' '#!/bin/bash'
  printf '%s\\n' "cd '$WORK' || exit 1"
  printf '%s\\n' "$START_COMMAND"
} | $SUDO tee "$RUNNER" >/dev/null
$SUDO chown "$SITE_USER:$SITE_USER" "$RUNNER"
$SUDO chmod 750 "$RUNNER"
cat <<UNIT_CONF | $SUDO tee "/etc/systemd/system/$UNIT.service" >/dev/null
[Unit]
Description=$DOMAIN
After=network.target

[Service]
Type=simple
User=$SITE_USER
${extraUnit}
Environment=PORT=$PORT
ExecStart=/bin/bash $RUNNER
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT_CONF
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$UNIT" >/dev/null 2>&1
${afterEnable}`,
            ),
        });
    }

    // ---- nginx ----

    const poolStep =
        runtime === "php"
            ? `
[ -d "/etc/php/$PHP_VERSION/fpm/pool.d" ] || { echo "PHP $PHP_VERSION (FPM) isn't installed on this server." >&2; exit 1; }
cat <<'POOL_CONF' | $SUDO tee "/etc/php/$PHP_VERSION/fpm/pool.d/$SITE_USER.conf" >/dev/null
${phpPool(site)}
POOL_CONF
$SUDO systemctl reload "php$PHP_VERSION-fpm"`
            : "";

    const autoRoot = runtime === "mern" || (runtime === "static" && s(site.build_command) !== "") ? "1" : "0";

    phases.push({
        step: "webserver",
        title: "Configuring nginx",
        script: script(
            { ...base, AUTO_ROOT: autoRoot },
            `
${poolStep}
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
cat <<'NGINX_CONF' | $SUDO tee "$CONF" >/dev/null
${vhost(site, aliases)}
NGINX_CONF
$SUDO sed -i "s#__DOC_ROOT__#$DOC_ROOT#g" "$CONF"
$SUDO ln -sf "$CONF" "/etc/nginx/sites-enabled/$DOMAIN.conf"
if ! $SUDO nginx -t >/dev/null 2>&1; then
  $SUDO nginx -t 2>&1 || true
  $SUDO rm -f "/etc/nginx/sites-enabled/$DOMAIN.conf"
  exit 1
fi
$SUDO systemctl reload nginx
echo "nginx is serving $DOMAIN"`,
        ),
    });

    return phases;
}

function lastLine(stderr: string, stdout: string): string {
    const text = stderr.trim() || stdout.trim();
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    return (lines[lines.length - 1] ?? "Command failed.").slice(0, 300);
}

export class SiteProvisioner {
    /** Fire and forget. run() never throws; failures are saved on the row. */
    static start(siteId: number): void {
        void SiteProvisioner.run(siteId);
    }

    static async run(siteId: number): Promise<void> {
        let log = "";

        try {
            const site = (await Site.find(siteId)) as SiteRow | null;
            if (!site) return;

            const server = (await Server.find(site.server_id)) as ServerRow | null;
            if (!server || (await teamIdOfRow(server)) !== (await teamIdOfRow(site))) {
                throw new Error("The server no longer exists.");
            }

            let source: Source | null = null;
            if (Number(site.source_control_id) !== 0) {
                // The column is `token` (encrypted), not api_token.
                const sc = (await SourceProvider.find(site.source_control_id)) as
                    | { user_id: number; team_id?: number | null; kind: string; token: string }
                    | null;
                if (!sc || (await teamIdOfRow(sc)) !== (await teamIdOfRow(site))) {
                    throw new Error("The source control connection no longer exists.");
                }
                source = { kind: sc.kind, token: CryptoService.decrypt(sc.token) };
            }

            const token = source?.token ?? "";
            const mask = (text: string) => (token ? text.split(token).join("***") : text);
            const target = serverTarget(server as never);

            await Site.update(siteId, { status: "creating", step: "user", error: "", log: "" });

            for (const phase of buildPhases(site, source)) {
                await Site.update(siteId, { step: phase.step });
                log += `==> ${phase.title}\n`;

                const result = await sshExec(target, phase.script, 20 * 60_000);
                const out = mask([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
                if (out) log += out + "\n";
                log += "\n";
                await Site.update(siteId, { log });

                if (result.code !== 0) {
                    throw new Error(mask(lastLine(result.stderr, result.stdout)));
                }
            }

            await Site.update(siteId, { status: "ready", step: "ready", log });
        } catch (err) {
            const message = err instanceof Error ? err.message : "Provisioning failed.";
            await Site.update(siteId, { status: "failed", error: message.slice(0, 500), log });
        }
    }
}