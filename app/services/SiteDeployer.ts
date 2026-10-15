/**
 * Deploys a site that is already provisioned. Phases, one SSH call each:
 *
 *   pull     git pull --ff-only (token passed through git's env config)
 *   env      writes the saved env to the site's .env (mode 600)
 *   script   runs the deployment script as the isolated user
 *   restart  restarts the Node service, or reloads php-fpm
 *
 * run() never throws; failures are saved on the row.
 */

import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { CryptoService } from "./CryptoService.js";
import { sshExec } from "./Ssh.js";
import { getType } from "./SiteTypes.js";
import { shellScript, serverTarget } from "./Shell.js";

export interface DeployRow {
    id: number;
    server_id: number;
    source_control_id: number;
    type: string;
    domain: string;
    isolated_user: string;
    php_version: string;
    port: number;
    repository: string;
    branch: string;
    app_directory: string;
    backend_directory: string;
    build_command: string;
    start_command: string;
    deploy_script: string;
    env_content: string;
    [key: string]: unknown;
}

interface Phase {
    title: string;
    script: string;
}

const DEPLOY_TIMEOUT_MS = 20 * 60_000;

const s = (value: unknown) => String(value ?? "");

/** A deploy needs a repository the site was cloned from. */
export function canDeploy(site: DeployRow): boolean {
    return (
        getType(site.type)?.usesRepository !== false &&
        Number(site.source_control_id) !== 0 &&
        s(site.repository) !== ""
    );
}

/** Folder (relative to the site root) holding .env, or null if the type has no .env. */
function envDirFor(site: DeployRow): string | null {
    if (site.type === "wordpress") return null;
    const runtime = getType(site.type)?.runtime ?? "static";
    if (runtime === "php") return "";
    if (runtime === "node") return s(site.app_directory);
    if (runtime === "mern") return s(site.backend_directory);
    return null;
}

/** Absolute path of the .env file on the server, or "" when the type has none. */
export function envPathFor(site: DeployRow): string {
    const dir = envDirFor(site);
    if (dir === null) return "";
    const root = `/home/${site.isolated_user}/${site.domain}`;
    return dir ? `${root}/${dir}/.env` : `${root}/.env`;
}

export function defaultDeployScript(site: DeployRow): string {
    const runtime = getType(site.type)?.runtime ?? "static";
    const build = s(site.build_command).trim();
    const npmInstall = "if [ -f package-lock.json ]; then npm ci; else npm install; fi";
    const cd = (dir: string) => (dir ? `cd "$SITE_ROOT/${dir}"` : `cd "$SITE_ROOT"`);

    // Fails loudly if Composer is missing, so an empty path can never reach php.
    // error_reporting=22527 is E_ALL minus E_DEPRECATED and E_STRICT: Ubuntu's
    // packaged Composer is old and prints thousands of deprecation lines on PHP 8.4.
    const composer = `COMPOSER_BIN="$(command -v composer)" || { echo "Composer is not installed on this server. Install it from the server's Packages page, then deploy again." >&2; exit 1; }
php$PHP_VERSION -d error_reporting=22527 "$COMPOSER_BIN" install --no-dev --no-interaction --prefer-dist --optimize-autoloader`;

   if (site.type === "laravel") {
  return `cd "$SITE_ROOT"

COMPOSER_BIN="$(command -v composer)" || { echo "Composer is not installed on this server. Install it from the Packages page, then deploy again." >&2; exit 1; }
php$PHP_VERSION -d error_reporting=22527 "$COMPOSER_BIN" install --no-dev --no-interaction --prefer-dist --optimize-autoloader

if [ -f package.json ]; then
  command -v npm >/dev/null || { echo "Node.js is not installed on this server. Install it from the Packages page, then deploy again." >&2; exit 1; }
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
  npm run build
fi

php$PHP_VERSION artisan migrate --force
php$PHP_VERSION artisan storage:link 2>/dev/null || true
php$PHP_VERSION artisan optimize:clear
php$PHP_VERSION artisan optimize

echo "Deployment completed."`;
}
    if (site.type === "wordpress") {
        return `echo "Nothing to deploy for this site type."`;
    }

    if (runtime === "php") {
        return [`cd "$SITE_ROOT"`, `if [ -f composer.json ]; then`, composer, `fi`].join("\n");
    }

    if (runtime === "mern") {
        const lines = [cd(s(site.backend_directory)), npmInstall, "", cd(s(site.app_directory)), npmInstall];
        if (build) lines.push(build);
        return lines.join("\n");
    }

    // node and static
    const lines = [cd(s(site.app_directory)), npmInstall];
    if (build) lines.push(build);
    return lines.join("\n");
}

// The deploy_log column is TEXT-sized (64 KB in bytes). Keep the tail, because
// that is where the error is, and stay under the limit even for 4-byte chars.
// Sized for a MEDIUMTEXT column (16 MB); lower it if the column is plain TEXT.
const MAX_LOG_CHARS = 200_000;

function clip(text: string): string {
    if (text.length <= MAX_LOG_CHARS) return text;
    return "[... earlier output trimmed ...]\n" + text.slice(-MAX_LOG_CHARS);
}

function lastLine(stderr: string, stdout: string): string {
    const text = stderr.trim() || stdout.trim();
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    return (lines[lines.length - 1] ?? "Command failed.").slice(0, 300);
}

/** Same pool file the site-creation job writes (socket name matches the nginx vhost). */
function fpmPool(site: DeployRow): string {
    return `[${site.isolated_user}]
user = ${site.isolated_user}
group = ${site.isolated_user}
listen = /run/php/php${s(site.php_version)}-fpm-${site.isolated_user}.sock
listen.owner = www-data
listen.group = www-data
pm = ondemand
pm.max_children = 10
pm.process_idle_timeout = 10s
`;
}

function buildPhases(site: DeployRow, source: { kind: string; token: string } | null): Phase[] {
    const runtime = getType(site.type)?.runtime ?? "static";
    const root = `/home/${site.isolated_user}/${site.domain}`;

    const base: Record<string, string> = {
        SITE_USER: site.isolated_user,
        SITE_ROOT: root,
        DOMAIN: site.domain,
        PHP_VERSION: s(site.php_version),
        BRANCH: s(site.branch),
        APP_DIR: s(site.app_directory),
        BACKEND_DIR: s(site.backend_directory),
        PORT: String(Number(site.port) || 0),
    };

    const phases: Phase[] = [];

    // ---- pull ----
    if (source) {
        const gitUser = source.kind === "gitlab" ? "oauth2" : "x-access-token";
        phases.push({
            title: "Pulling the latest code",
            script: shellScript(
                { ...base, GIT_USER: gitUser, GIT_TOKEN: source.token },
                `
cd "$SITE_ROOT"
[ -d .git ] || { echo "There is no git repository in $SITE_ROOT." >&2; exit 1; }
AUTH="$(printf '%s:%s' "$GIT_USER" "$GIT_TOKEN" | base64 -w0)"
as_user env GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader "GIT_CONFIG_VALUE_0=Authorization: Basic $AUTH" git pull --ff-only origin "$BRANCH"`,
            ),
        });
    }

    // ---- env ----
    const envPath = envPathFor(site);
    const envText = s(site.env_content) ? CryptoService.decrypt(s(site.env_content)) : "";
    if (envPath && envText.trim() !== "") {
        phases.push({
            title: "Writing .env",
            script: shellScript(
                {
                    ...base,
                    ENV_PATH: envPath,
                    ENV_B64: Buffer.from(envText.endsWith("\n") ? envText : envText + "\n", "utf8").toString("base64"),
                },
                `
$SUDO mkdir -p "$(dirname "$ENV_PATH")"
printf %s "$ENV_B64" | base64 -d | $SUDO tee "$ENV_PATH" >/dev/null
$SUDO chown "$SITE_USER:$SITE_USER" "$ENV_PATH"
$SUDO chmod 600 "$ENV_PATH"
echo "Wrote $ENV_PATH"`,
            ),
        });
    }

    // ---- php-fpm pool ----
    // Self-healing, and deliberately BEFORE the build: nginx sends PHP to this
    // site's own FPM socket, so a missing pool means a 502 no matter what the
    // app does. Doing this first means a failing build can't leave it broken.
    if (runtime === "php") {
        phases.push({
            title: "Checking PHP-FPM",
            script: shellScript(
                { ...base, POOL_B64: Buffer.from(fpmPool(site), "utf8").toString("base64") },
                `
if [ ! -d "/etc/php/$PHP_VERSION/fpm" ]; then
  echo "PHP-FPM $PHP_VERSION is not installed on this server. Install PHP $PHP_VERSION from the server's Packages page, then deploy again." >&2
  exit 1
fi
POOL="/etc/php/$PHP_VERSION/fpm/pool.d/$SITE_USER.conf"
CREATED=0
if [ ! -f "$POOL" ]; then
  printf %s "$POOL_B64" | base64 -d | $SUDO tee "$POOL" >/dev/null
  CREATED=1
  echo "Created the PHP-FPM pool for $SITE_USER"
fi
$SUDO "php-fpm$PHP_VERSION" -t
if [ "$CREATED" = "1" ]; then
  $SUDO systemctl restart "php$PHP_VERSION-fpm"
fi
echo "--- PHP-FPM sockets"
ls -l /run/php/ 2>&1 || true
echo "--- recent nginx errors"
$SUDO tail -n 15 /var/log/nginx/error.log 2>&1 || true`,
            ),
        });
    }

    // ---- script ----
    const userScript = s(site.deploy_script).trim() !== "" ? s(site.deploy_script) : defaultDeployScript(site);
    // The ERR trap prints which command failed as the last stderr line, so the
    // failure message names the real culprit (not whatever a tool printed last).
    const runner =
        `#!/bin/bash
set -eEo pipefail
trap 'echo "Command failed (exit $?): $BASH_COMMAND" >&2' ERR
cd "$SITE_ROOT"
` +
        userScript.replace(/\r\n/g, "\n") +
        "\n";

    // Preflight: PHP sites need the chosen PHP version on the server. Say so
    // plainly instead of failing with "php8.x: command not found" mid-script.
    // (Composer is checked by the default script itself, only when it needs it.)
    const phpCheck =
        runtime === "php" && site.type !== "wordpress"
            ? `
command -v "php$PHP_VERSION" >/dev/null 2>&1 || { echo "PHP $PHP_VERSION is not installed on this server. Install it from the server's Packages page, then deploy again." >&2; exit 1; }`
            : "";

    phases.push({
        title: "Running the deployment script",
        script: shellScript(
            { ...base, SCRIPT_B64: Buffer.from(runner, "utf8").toString("base64") },
            `${phpCheck}
RUNNER="/home/$SITE_USER/.deploy-$SITE_USER.sh"
printf %s "$SCRIPT_B64" | base64 -d | $SUDO tee "$RUNNER" >/dev/null
$SUDO chown "$SITE_USER:$SITE_USER" "$RUNNER"
$SUDO chmod 700 "$RUNNER"
cd "$SITE_ROOT"
as_user env SITE_ROOT="$SITE_ROOT" DOMAIN="$DOMAIN" PHP_VERSION="$PHP_VERSION" BRANCH="$BRANCH" APP_DIR="$APP_DIR" BACKEND_DIR="$BACKEND_DIR" PORT="$PORT" bash "$RUNNER"
echo "Deployment script finished"`,
        ),
    });

    // ---- restart ----
    if ((runtime === "node" || runtime === "mern") && s(site.start_command) !== "") {
        phases.push({
            title: "Restarting the app",
            script: shellScript(
                base,
                `
UNIT="app-$SITE_USER"
if [ ! -f "/etc/systemd/system/$UNIT.service" ]; then
  echo "No service named $UNIT exists yet, nothing to restart."
  exit 0
fi
$SUDO systemctl restart "$UNIT"
sleep 3
if $SUDO systemctl is-active --quiet "$UNIT"; then
  echo "App restarted and running on port $PORT"
else
  $SUDO journalctl -u "$UNIT" -n 15 --no-pager || true
  echo "The app did not stay up after the restart." >&2
  exit 1
fi`,
            ),
        });
    }

    if (runtime === "php") {
        phases.push({
            title: "Reloading PHP-FPM",
            script: shellScript(
                base,
                `
$SUDO systemctl reload "php$PHP_VERSION-fpm"
echo "PHP-FPM reloaded"`,
            ),
        });
    }

    return phases;
}

export class SiteDeployer {
    static start(siteId: number): void {
        // run() handles its own errors; this is a last line of defence so a
        // bug here can never become an unhandled rejection that kills the server.
        SiteDeployer.run(siteId).catch((err) => {
            console.error(`Deploy of site ${siteId} crashed:`, err);
        });
    }

    static async run(siteId: number): Promise<void> {
        let log = "";

        // Never throws. If the log can't be saved, the status still is.
        const save = async (patch: Record<string, unknown>) => {
            try {
                await Site.update(siteId, { ...patch, deploy_log: clip(log) });
            } catch (err) {
                console.error(`Couldn't save the deploy log for site ${siteId}:`, err);
                try {
                    if (Object.keys(patch).length > 0) await Site.update(siteId, patch);
                } catch (err2) {
                    console.error(`Couldn't save the deploy status for site ${siteId}:`, err2);
                }
            }
        };

        try {
            const site = (await Site.find(siteId)) as DeployRow | null;
            if (!site) return;

            const server = (await Server.find(site.server_id)) as
                | { host: string; port: number; ssh_user: string; ssh_key: string }
                | null;
            if (!server) throw new Error("The server no longer exists.");

            let source: { kind: string; token: string } | null = null;
            if (Number(site.source_control_id) !== 0) {
                const sc = (await SourceProvider.find(site.source_control_id)) as
                    | { kind: string; token: string }
                    | null;
                if (!sc) throw new Error("The source control connection no longer exists.");
                source = { kind: sc.kind, token: CryptoService.decrypt(sc.token) };
            }

            const token = source?.token ?? "";
            const mask = (text: string) => (token ? text.split(token).join("***") : text);
            const target = serverTarget(server);

            await save({ deploy_status: "deploying" });

            for (const phase of buildPhases(site, source)) {
                log += `==> ${phase.title}\n`;
                await save({});

                const result = await sshExec(target, phase.script, DEPLOY_TIMEOUT_MS);
                const out = mask([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
                if (out) log += out + "\n";
                log += "\n";
                await save({});

                if (result.code !== 0) {
                    throw new Error(mask(lastLine(result.stderr, result.stdout)));
                }
            }

            log += "Deployed successfully.\n";
            await save({ deploy_status: "success", deployed_at: new Date().toISOString() });
        } catch (err) {
            const message = err instanceof Error ? err.message : "Deployment failed.";
            log += `\nFAILED: ${message}\n`;
            await save({ deploy_status: "failed" });
        }
    }
}