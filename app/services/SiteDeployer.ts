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
    const composer = `php$PHP_VERSION "$(command -v composer)" install --no-dev --no-interaction --prefer-dist --optimize-autoloader`;

    if (site.type === "laravel") {
        return [
            `cd "$SITE_ROOT"`,
            composer,
            `php$PHP_VERSION artisan migrate --force`,
            `php$PHP_VERSION artisan config:cache`,
            `php$PHP_VERSION artisan route:cache`,
            `php$PHP_VERSION artisan view:cache`,
        ].join("\n");
    }

    if (site.type === "wordpress") {
        return `echo "Nothing to deploy for this site type."`;
    }

    if (runtime === "php") {
        return [`cd "$SITE_ROOT"`, `if [ -f composer.json ]; then`, `  ${composer}`, `fi`].join("\n");
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

function lastLine(stderr: string, stdout: string): string {
    const text = stderr.trim() || stdout.trim();
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    return (lines[lines.length - 1] ?? "Command failed.").slice(0, 300);
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

    // ---- script ----
    const userScript = s(site.deploy_script).trim() !== "" ? s(site.deploy_script) : defaultDeployScript(site);
    const runner = '#!/bin/bash\nset -eo pipefail\ncd "$SITE_ROOT"\n' + userScript.replace(/\r\n/g, "\n") + "\n";
    phases.push({
        title: "Running the deployment script",
        script: shellScript(
            { ...base, SCRIPT_B64: Buffer.from(runner, "utf8").toString("base64") },
            `
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
if [ -d "/etc/php/$PHP_VERSION/fpm" ]; then
  $SUDO systemctl reload "php$PHP_VERSION-fpm"
  echo "PHP-FPM reloaded"
else
  echo "PHP $PHP_VERSION FPM not found, skipping reload."
fi`,
            ),
        });
    }

    return phases;
}

export class SiteDeployer {
    static start(siteId: number): void {
        void SiteDeployer.run(siteId);
    }

    static async run(siteId: number): Promise<void> {
        let log = "";

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

            await Site.update(siteId, { deploy_status: "deploying", deploy_log: "" });

            for (const phase of buildPhases(site, source)) {
                log += `==> ${phase.title}\n`;
                await Site.update(siteId, { deploy_log: log });

                const result = await sshExec(target, phase.script, DEPLOY_TIMEOUT_MS);
                const out = mask([result.stdout, result.stderr].filter(Boolean).join("\n").trim());
                if (out) log += out + "\n";
                log += "\n";
                await Site.update(siteId, { deploy_log: log });

                if (result.code !== 0) {
                    throw new Error(mask(lastLine(result.stderr, result.stdout)));
                }
            }

            log += "Deployed successfully.\n";
            await Site.update(siteId, {
                deploy_status: "success",
                deploy_log: log,
                deployed_at: new Date().toISOString(),
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : "Deployment failed.";
            log += `\nFAILED: ${message}\n`;
            await Site.update(siteId, { deploy_status: "failed", deploy_log: log });
        }
    }
}