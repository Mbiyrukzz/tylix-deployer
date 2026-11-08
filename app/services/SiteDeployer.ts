/**
 * Deploys a site that is already provisioned.
 *
 * HOW A DEPLOY RUNS NOW
 *
 *   1. The controller calls SiteDeployer.enqueue(): a Deployment row with
 *      status "queued" is created. Nothing runs yet.
 *   2. A runner loop (every 2s, in every process that imports this file
 *      unless TYLIX_DEPLOY_RUNNER=off) claims queued rows and runs them.
 *      The claim is a conditional update, so two processes never run the
 *      same deployment.
 *   3. A running deployment heartbeats every 15s. If the process dies
 *      (restart, crash, deploying the deployer itself), the sweeper fails
 *      the row within ~2 minutes. A clean SIGTERM fails it immediately.
 *   4. Cancel: the controller sets cancel_requested. A queued row is simply
 *      closed. A running one is stopped: the runner kills the running
 *      commands on the server, and the deploy script's own rollback runs.
 *
 * Rules the runner follows when picking work:
 *   - one deployment per server at a time (builds are heavy)
 *   - at most TYLIX_DEPLOY_CONCURRENCY (default 3) at once
 *   - a deploy of the deployer itself (domain listed in TYLIX_SELF_DOMAIN)
 *     runs alone: it waits for everything else to finish, and nothing else
 *     starts while it runs. This is what used to kill other deploys.
 *
 * Phases, one SSH call each:
 *
 *   pull     git pull --ff-only (token passed through git's env config),
 *            then prints the commit it landed on (saved on the history row)
 *   env      writes the saved env to the site's .env (mode 600)
 *   script   runs the deployment script as the isolated user
 *            (docker sites: as the ssh user through sudo, because Docker needs root)
 *   restart  restarts the app service (node, mern, python, java, go, ruby,
 *            dotnet, rust), or reloads php-fpm. Docker sites have no service:
 *            the deployment script itself swaps the container.
 *
 * Docker deploys:
 *   compose file  docker compose -p app-<user> up -d --build --remove-orphans
 *                 (your compose file must publish 127.0.0.1:${PORT}:<container port>)
 *   Dockerfile    build the image first, then replace the container; the old
 *                 container is only removed after the build succeeds, and the
 *                 previous image is restored if the new container doesn't stay up.
 *
 * Nothing here throws to the caller: failures are saved on the rows.
 */

import { randomBytes } from "node:crypto";
import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { Deployment } from "../models/Deployment.js";
import { SitePlugin } from "../models/SitePlugin.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { CryptoService } from "./CryptoService.js";
import { sshExec } from "./Ssh.js";
import { getType, isAppRuntime } from "./SiteTypes.js";
import { shellScript, serverTarget } from "./Shell.js";
import { teamIdOfRow } from "./TeamScope.js";

export interface DeployRow {
    id: number;
    user_id: number;
    team_id: number | null;
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

export interface DeploymentRow {
    id: number;
    site_id: number;
    user_id: number;
    team_id: number | null;
    status: string;
    log: string;
    branch: string;
    commit_sha: string;
    commit_message: string;
    cancel_requested: number;
    runner: string;
    queued_at: string;
    started_at: string;
    finished_at: string;
    heartbeat_at: string;
    [key: string]: unknown;
}

interface Phase {
    title: string;
    script: string;
    /** The pull phase prints the commit it landed on; execute() saves it. */
    capturesCommit?: boolean;
    /** This phase restarts services. For the deployer's own site it ends the process running the deploy. */
    restarts?: boolean;
}

// ---- tuning ----

const DEPLOY_TIMEOUT_MS = 20 * 60_000; // per SSH phase
const PHASE_GRACE_MS = 30_000; // extra wait before we stop waiting on sshExec itself
const HEARTBEAT_MS = 15_000; // a running deploy touches its rows this often
const STALE_MS = 2 * 60_000; // no heartbeat for this long = the process died
const SWEEP_MS = 30_000;
const POLL_MS = 2_000;
const CANCEL_POLL_MS = 2_000;
const CANCEL_GRACE_MS = 45_000; // after a cancel, how long we wait for the phase to end before giving up on it
// A safety valve only. Waiting is per server (see tick), so different customers never queue behind each other.
const MAX_CONCURRENT = Math.max(1, Number(process.env.TYLIX_DEPLOY_CONCURRENCY) || 50);
const RUNNER_ENABLED = String(process.env.TYLIX_DEPLOY_RUNNER ?? "on").toLowerCase() !== "off";
const RUNNER_ID = `${process.pid}-${randomBytes(3).toString("hex")}`;

const COMMIT_MARK = "TYLIX_COMMIT ";
const COMMIT_MSG_MARK = "TYLIX_COMMIT_MSG ";

const s = (value: unknown) => String(value ?? "");
const nowIso = () => new Date().toISOString();

/** Parses an ISO string, a Date, or MySQL's "YYYY-MM-DD HH:MM:SS" (read as UTC). NaN when empty. */
export function parseTime(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    const text = s(value).trim();
    if (!text) return NaN;
    const plain = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text);
    return new Date(plain ? text.replace(" ", "T") + "Z" : text).getTime();
}

/** True for the domain(s) of the deployer itself, set in TYLIX_SELF_DOMAIN (comma separated). */
export function isSelfDeploy(domain: string): boolean {
    const list = s(process.env.TYLIX_SELF_DOMAIN)
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
    return list.includes(s(domain).toLowerCase());
}

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
    if (
        runtime === "python" ||
        runtime === "java" ||
        runtime === "go" ||
        runtime === "ruby" ||
        runtime === "dotnet" ||
        runtime === "rust" ||
        runtime === "docker"
    ) {
        return s(site.app_directory);
    }
    return null;
}

/** Absolute path of the .env file on the server, or "" when the type has none. */
export function envPathFor(site: DeployRow): string {
    const dir = envDirFor(site);
    if (dir === null) return "";
    const root = `/home/${site.isolated_user}/${site.domain}`;
    return dir ? `${root}/${dir}/.env` : `${root}/.env`;
}

/**
 * Wraps deploy steps so a failure rolls the code back to the previous commit
 * and re-runs the same steps there. (Node, static, python, java, go, ruby,
 * dotnet and rust deploys. Docker has its own rollback, see dockerDeployScript.)
 *
 * Cancelling kills the running command, which fires the ERR trap below, so a
 * cancelled deploy rolls back exactly like a failed one.
 */
function guarded(steps: string[]): string {
    const body = steps.join("\n");
    return `cd "$SITE_ROOT"
SITE_USER="$(id -un)"
PREV="$(cat "/home/$SITE_USER/.prev-head-$SITE_USER" 2>/dev/null || true)"

redo() {
${body}
}

rollback() {
  set +e
  trap - ERR
  echo "Deployment failed, rolling back." >&2
  if [ -n "$PREV" ]; then
    git reset --keep "$PREV" >&2 && ( redo ) >&2
  fi
  echo "Command failed (exit $1): $2. Code rolled back to the previous version." >&2
  exit "$1"
}
trap 'rc=$?; cmd=$BASH_COMMAND; rollback "$rc" "$cmd"' ERR

redo`;
}

/**
 * The default script for a docker site. It runs as root (see the script phase),
 * with SITE_USER, SITE_ROOT, APP_DIR and PORT in the environment.
 *
 * A failed build never touches what is running. Only the Dockerfile path needs
 * an explicit rollback, because it replaces the container by hand.
 * Avoid "$" followed by "{" in this text: it sits inside a template literal.
 */
function dockerDeployScript(): string {
    return `cd "$SITE_ROOT"
WORK="$SITE_ROOT"
if [ -n "$APP_DIR" ]; then WORK="$SITE_ROOT/$APP_DIR"; fi
[ -d "$WORK" ] || { echo "Folder '$APP_DIR' was not found in the repository." >&2; exit 1; }
cd "$WORK"

command -v docker >/dev/null 2>&1 || { echo "Docker is not installed on this server. Install it from the server's Packages page, then deploy again." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "The Docker daemon is not running. Start it with: systemctl enable --now docker" >&2; exit 1; }

NAME="app-$SITE_USER"
IMAGE="tylix-$SITE_USER"

COMPOSE=""
for f in compose.yaml compose.yml docker-compose.yml docker-compose.yaml; do
  if [ -f "$f" ]; then COMPOSE="$f"; break; fi
done

if [ -n "$COMPOSE" ]; then
  docker compose version >/dev/null 2>&1 || { echo "The Docker Compose plugin is not installed on this server. Install it from the server's Packages page, then deploy again." >&2; exit 1; }
  echo "Using $COMPOSE (project $NAME, app port $PORT)"
  PORT="$PORT" docker compose -p "$NAME" -f "$COMPOSE" up -d --build --remove-orphans
  sleep 5
  if [ -z "$(docker compose -p "$NAME" -f "$COMPOSE" ps -q)" ]; then
    docker compose -p "$NAME" -f "$COMPOSE" logs --tail 30 >&2 || true
    echo "No container is running after docker compose up. Check that your compose file publishes 127.0.0.1:$PORT." >&2
    exit 1
  fi
  echo "Compose project $NAME is up"
else
  [ -f Dockerfile ] || { echo "There is no Dockerfile or compose file in $WORK." >&2; exit 1; }

  echo "Building the image (the running container is untouched until this succeeds)"
  docker build -t "$IMAGE:new" .

  ENVARG=""
  if [ -f .env ]; then ENVARG="--env-file .env"; fi

  if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then
    docker tag "$IMAGE:latest" "$IMAGE:previous"
  fi
  docker tag "$IMAGE:new" "$IMAGE:latest"

  start_container() {
    docker run -d --name "$NAME" --restart unless-stopped $ENVARG -e PORT="$PORT" -p "127.0.0.1:$PORT:$PORT" "$1" >/dev/null
  }

  healthy() {
    sleep 5
    [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$NAME" 2>/dev/null)" = "true 0" ]
  }

  docker rm -f "$NAME" >/dev/null 2>&1 || true

  if start_container "$IMAGE:latest" && healthy; then
    echo "Container $NAME is running on 127.0.0.1:$PORT"
  else
    echo "The new container did not stay up. Last log lines:" >&2
    docker logs --tail 30 "$NAME" >&2 || true
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    if docker image inspect "$IMAGE:previous" >/dev/null 2>&1; then
      echo "Restoring the previous version." >&2
      docker tag "$IMAGE:previous" "$IMAGE:latest"
      start_container "$IMAGE:latest" || true
    fi
    echo "The new container did not stay up. Make sure the app listens on the PORT variable. The previous version was restored if there was one." >&2
    exit 1
  fi
fi

docker image prune -f >/dev/null 2>&1 || true
echo "Deployment completed."`;
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
SITE_USER="$(id -un)"
PREV="$(cat "/home/$SITE_USER/.prev-head-$SITE_USER" 2>/dev/null || true)"
PHP="php$PHP_VERSION"
COMPOSER_BIN="$(command -v composer)" || { echo "Composer is not installed on this server. Install it from the Packages page, then deploy again." >&2; exit 1; }
DOWN=0

install_deps() {
  $PHP -d error_reporting=22527 "$COMPOSER_BIN" install --no-dev --no-interaction --prefer-dist --optimize-autoloader
}

rollback() {
  set +e
  trap - ERR
  echo "Deployment failed, rolling back." >&2
  if [ -n "$PREV" ]; then
    git reset --keep "$PREV" >&2
    install_deps >&2
  fi
  if [ "$DOWN" = "1" ]; then $PHP artisan up >&2; fi
  echo "Command failed (exit $1): $2. Code rolled back; database migrations were NOT undone." >&2
  exit "$1"
}
trap 'rc=$?; cmd=$BASH_COMMAND; rollback "$rc" "$cmd"' ERR

install_deps

if [ -f package.json ]; then
  command -v npm >/dev/null || { echo "Node.js is not installed on this server. Install it from the Packages page, then deploy again." >&2; exit 1; }
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
  npm run build
fi

$PHP artisan down --retry=60
DOWN=1
$PHP artisan migrate --force
$PHP artisan storage:link 2>/dev/null || true
$PHP artisan optimize:clear
$PHP artisan optimize
$PHP artisan up
DOWN=0

echo "Deployment completed."`;
    }

    if (site.type === "wordpress") {
        return `echo "Nothing to deploy for this site type."`;
    }

    if (runtime === "docker") {
        return dockerDeployScript();
    }

    if (runtime === "php") {
        return [`cd "$SITE_ROOT"`, `if [ -f composer.json ]; then`, composer, `fi`].join("\n");
    }

    if (runtime === "mern") {
        const lines = [cd(s(site.backend_directory)), npmInstall, "", cd(s(site.app_directory)), npmInstall];
        if (build) lines.push(build);
        return guarded(lines);
    }

    if (runtime === "python") {
        // gunicorn (django) or uvicorn + gunicorn (fastapi) are installed here as a safety net,
        // in case the project's requirements.txt doesn't list them.
        const server = site.type === "fastapi" ? "'uvicorn[standard]' gunicorn" : "gunicorn";
        const lines = [
            cd(s(site.app_directory)),
            `command -v python3 >/dev/null && python3 -c 'import venv, ensurepip' 2>/dev/null || { echo "Python 3 with venv is not installed on this server. Install it from the server's Packages page, then deploy again." >&2; exit 1; }`,
            `[ -d .venv ] || python3 -m venv .venv`,
            `.venv/bin/pip install --upgrade pip wheel`,
            `if [ -f requirements.txt ]; then .venv/bin/pip install -r requirements.txt; fi`,
            `.venv/bin/pip install ${server}`,
        ];
        if (build) lines.push(build);
        return guarded(lines);
    }

    if (runtime === "java") {
        // An empty build command auto-detects the wrapper or system Maven.
        const autodetect = `if [ -f mvnw ]; then sh mvnw -B -DskipTests package; elif [ -f gradlew ]; then sh gradlew build -x test; else mvn -B -DskipTests package; fi`;
        return guarded([
            cd(s(site.app_directory)),
            `command -v java >/dev/null && command -v javac >/dev/null || { echo "The JDK is not installed on this server. Install Java from the server's Packages page, then deploy again." >&2; exit 1; }`,
            build || autodetect,
        ]);
    }

    if (runtime === "go") {
        return guarded([
            cd(s(site.app_directory)),
            `command -v go >/dev/null || { echo "Go is not installed on this server. Install it from the server's Packages page, then deploy again." >&2; exit 1; }`,
            build || "go build -o app .",
        ]);
    }

    if (runtime === "ruby") {
        // Gems go in vendor/bundle inside the site, so nothing is installed system-wide.
        // A build command (assets, migrations) is optional and left empty by default.
        const lines = [
            cd(s(site.app_directory)),
            `command -v ruby >/dev/null && command -v bundle >/dev/null || { echo "Ruby is not installed on this server. Install it from the server's Packages page, then deploy again." >&2; exit 1; }`,
            `bundle config set --local path vendor/bundle`,
            `bundle config set --local without 'development test'`,
            `bundle install`,
        ];
        if (build) lines.push(build);
        return guarded(lines);
    }

    if (runtime === "dotnet") {
        return guarded([
            cd(s(site.app_directory)),
            `command -v dotnet >/dev/null || { echo "The .NET SDK is not installed on this server. Install it from the server's Packages page, then deploy again." >&2; exit 1; }`,
            `export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1`,
            build || "dotnet publish -c Release -o publish",
        ]);
    }

    if (runtime === "rust") {
        return guarded([
            cd(s(site.app_directory)),
            `command -v cargo >/dev/null || { echo "Rust is not installed on this server. Install it from the server's Packages page, then deploy again." >&2; exit 1; }`,
            build || "cargo build --release",
        ]);
    }

    // node and static
    const lines = [cd(s(site.app_directory)), npmInstall];
    if (build) lines.push(build);
    return guarded(lines);
}

// The deploy_log column is MEDIUMTEXT (16 MB). Keep the tail, because that is
// where the error is.
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

/** Pulls the commit marker lines out of a phase's output. Returns what was found and the cleaned text. */
function extractCommit(text: string): { sha: string; message: string; clean: string } {
    let sha = "";
    let message = "";
    const kept: string[] = [];

    for (const line of text.split("\n")) {
        const t = line.trim();

        if (t.startsWith(COMMIT_MSG_MARK)) {
            try {
                message = Buffer.from(t.slice(COMMIT_MSG_MARK.length).trim(), "base64").toString("utf8").trim();
            } catch {
                message = "";
            }
            continue;
        }

        if (t.startsWith(COMMIT_MARK)) {
            const value = t.slice(COMMIT_MARK.length).trim();
            if (/^[0-9a-f]{7,64}$/i.test(value)) sha = value;
            continue;
        }

        kept.push(line);
    }

    return { sha, message: message.slice(0, 500), clean: kept.join("\n").trim() };
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

/** Services that plugins installed for this site; restarted after every deploy. */
const PLUGIN_UNITS: Record<string, { unit: string; reload?: boolean }> = {
    octane: { unit: "octane-$SITE_USER", reload: true },
    reverb: { unit: "reverb-$SITE_USER" },
    "tylix-queue": { unit: "tylix-queue-$SITE_USER" },
};

function pluginRestartScript(plugins: string[]): string {
    const units = plugins.map((p) => PLUGIN_UNITS[p]).filter(Boolean);
    if (units.length === 0) return "";

    const calls = units
        .map((u) => `bounce "${u.unit}" ${u.reload ? "reload" : "restart"}`)
        .join("\n");

    return `
bounce() {
  U="$1"
  if [ ! -f "/etc/systemd/system/$U.service" ]; then
    echo "No service $U, skipping."
    return 0
  fi
  if [ "$2" = "reload" ]; then
    $SUDO systemctl reload "$U" || $SUDO systemctl restart "$U"
  else
    $SUDO systemctl restart "$U"
  fi
  sleep 3
  if $SUDO systemctl is-active --quiet "$U"; then
    echo "$U is running"
  else
    $SUDO journalctl -u "$U" -n 15 --no-pager || true
    echo "The service $U did not stay up after the deploy." >&2
    return 1
  fi
}
${calls}`;
}

/**
 * Stops whatever the deployment script is running on the server.
 *
 * It finds the runner script's bash process and kills the whole process tree
 * UNDER it (never the runner itself). The runner then sees a failing command,
 * its ERR trap fires, and the script rolls back on its own, exactly as for any
 * other failure (for Laravel that includes "artisan up").
 *
 * The pull phase has no runner script, so a running `git pull` is stopped too.
 */
function cancelScript(site: DeployRow): string {
    const docker = (getType(site.type)?.runtime ?? "static") === "docker";
    const pattern = docker
        ? `^bash /run/tylix-deploy-$SITE_USER\\.sh$`
        : `^bash /home/$SITE_USER/\\.deploy-$SITE_USER\\.sh$`;

    return shellScript(
        { SITE_USER: site.isolated_user, SITE_ROOT: `/home/${site.isolated_user}/${site.domain}` },
        `
kill_tree() {
  for c in $(pgrep -P "$1" || true); do kill_tree "$c"; done
  $SUDO kill -TERM "$1" 2>/dev/null || true
}
RUNNER_RE="${pattern}"
STOPPED=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  for P in $(pgrep -f "$RUNNER_RE" || true); do
    for c in $(pgrep -P "$P" || true); do
      kill_tree "$c"
      STOPPED=1
    done
  done
  if [ "$STOPPED" = "1" ]; then break; fi
  sleep 1
done
if $SUDO pkill -TERM -u "$SITE_USER" -f "^git (pull|fetch)" 2>/dev/null; then STOPPED=1; fi
if [ "$STOPPED" = "1" ]; then echo "Stopped the running commands on the server."; else echo "Nothing was running on the server to stop."; fi`,
    );
}

function buildPhases(site: DeployRow, source: { kind: string; token: string } | null, plugins: string[]): Phase[] {
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
            capturesCommit: true,
            script: shellScript(
                { ...base, GIT_USER: gitUser, GIT_TOKEN: source.token },
                `
cd "$SITE_ROOT"
[ -d .git ] || { echo "There is no git repository in $SITE_ROOT." >&2; exit 1; }
as_user git rev-parse HEAD | $SUDO tee "/home/$SITE_USER/.prev-head-$SITE_USER" >/dev/null
AUTH="$(printf '%s:%s' "$GIT_USER" "$GIT_TOKEN" | base64 -w0)"
as_user env GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader "GIT_CONFIG_VALUE_0=Authorization: Basic $AUTH" git pull --ff-only origin "$BRANCH"
echo "${COMMIT_MARK}$(as_user git rev-parse HEAD)"
echo "${COMMIT_MSG_MARK}$(as_user git log -1 --format=%s | base64 -w0)"`,
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

    if (runtime === "docker") {
        // Docker needs root, so this script runs as the ssh user through sudo, not as
        // the isolated user. It is written to a root-owned file in /run (writable by
        // root only, so the site user can never edit what root is about to run).
        // The path is fixed per site so a cancel can find the process.
        phases.push({
            title: "Building and starting the container",
            script: shellScript(
                { ...base, SCRIPT_B64: Buffer.from(runner, "utf8").toString("base64") },
                `
RUNNER="/run/tylix-deploy-$SITE_USER.sh"
printf %s "$SCRIPT_B64" | base64 -d | $SUDO tee "$RUNNER" >/dev/null
$SUDO chmod 700 "$RUNNER"
trap '$SUDO rm -f "$RUNNER"' EXIT
cd "$SITE_ROOT"
$SUDO env SITE_USER="$SITE_USER" SITE_ROOT="$SITE_ROOT" DOMAIN="$DOMAIN" BRANCH="$BRANCH" APP_DIR="$APP_DIR" BACKEND_DIR="$BACKEND_DIR" PORT="$PORT" bash "$RUNNER"
echo "Deployment script finished"`,
            ),
        });
    } else {
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
    }

    // ---- restart ----
    // Docker sites have no systemd service: the script above already swapped the container.
    const appRuntime = isAppRuntime(runtime) && runtime !== "docker";

    if (appRuntime && s(site.start_command) !== "") {
        phases.push({
            title: "Restarting the app",
            restarts: true,
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
            restarts: true,
            script: shellScript(
                base,
                `
$SUDO systemctl reload "php$PHP_VERSION-fpm"
echo "PHP-FPM reloaded"`,
            ),
        });
    }

    const pluginScript = pluginRestartScript(plugins);
    if (pluginScript) {
        phases.push({
            title: "Restarting plugin services",
            restarts: true,
            script: shellScript(base, pluginScript),
        });
    }

    return phases;
}

// =====================================================================
// Running a deployment
// =====================================================================

class CancelError extends Error {}

interface ActiveRun {
    siteId: number;
    /** Called on SIGTERM/SIGINT: records the deployment as failed right away. */
    interrupt: (reason: string) => Promise<void>;
}

/** Deployments this process is running right now, by deployment id. */
const active = new Map<number, ActiveRun>();

/** Rejects if `work` hasn't settled in `ms`, or when any `extra` promise rejects (a cancel). */
function withDeadline<T>(work: Promise<T>, ms: number, what: string, extra: Promise<never>[] = []): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`"${what}" did not finish within ${Math.round(ms / 60_000)} minutes.`)),
            ms,
        );
    });
    return Promise.race([work, deadline, ...extra]).finally(() => clearTimeout(timer));
}

async function execute(deploymentId: number, siteId: number): Promise<void> {
    let log = "";
    let finished = false;
    let earlyDone = false; // self deploy: recorded as success before the restart that ends this process
    let cancelFlag = false;
    let inflight = 0;
    let queue: Promise<void> = Promise.resolve();

    /**
     * Never throws. Saves run one at a time and read `log` when they run, so a
     * late heartbeat can never overwrite the final log with an older one.
     * Every save also stamps heartbeat_at, which is what the sweeper watches.
     */
    const save = (sitePatch: Record<string, unknown> = {}, depPatch: Record<string, unknown> = {}): Promise<void> => {
        inflight++;
        queue = queue.then(async () => {
            const text = clip(log);
            try {
                try {
                    await Site.update(siteId, { ...sitePatch, deploy_log: text });
                } catch (err) {
                    console.error(`Couldn't save the deploy log for site ${siteId}:`, err);
                    try {
                        if (Object.keys(sitePatch).length > 0) await Site.update(siteId, sitePatch);
                    } catch (err2) {
                        console.error(`Couldn't save the deploy status for site ${siteId}:`, err2);
                    }
                }

                try {
                    await Deployment.update(deploymentId, { ...depPatch, log: text, heartbeat_at: nowIso() });
                } catch (err) {
                    console.error(`Couldn't save deployment ${deploymentId}:`, err);
                    try {
                        await Deployment.update(deploymentId, { ...depPatch, heartbeat_at: nowIso() });
                    } catch (err2) {
                        console.error(`Couldn't save the status of deployment ${deploymentId}:`, err2);
                    }
                }
            } finally {
                inflight--;
            }
        });
        return queue;
    };

    const interrupt = async (reason: string) => {
        if (finished || earlyDone) return;
        finished = true;
        log += `\nFAILED: ${reason}\n`;
        await save({ deploy_status: "failed" }, { status: "failed", finished_at: nowIso() });
    };

    active.set(deploymentId, { siteId, interrupt });

    let beat: ReturnType<typeof setInterval> | undefined;
    let watcher: ReturnType<typeof setInterval> | undefined;

    try {
        const site = (await Site.find(siteId)) as DeployRow | null;
        if (!site) throw new Error("The site no longer exists.");

        const server = (await Server.find(site.server_id)) as
            | { user_id: number; team_id: number | null; host: string; port: number; ssh_user: string; ssh_key: string }
            | null;
        if (!server || (await teamIdOfRow(server)) !== (await teamIdOfRow(site))) {
            throw new Error("The server no longer exists.");
        }

        let source: { kind: string; token: string } | null = null;
        if (Number(site.source_control_id) !== 0) {
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
        const target = serverTarget(server);
        const self = isSelfDeploy(site.domain);

        // The deployment row is already "deploying" (the claim did that).
        await save({ deploy_status: "deploying" });

        // Heartbeat: proof of life for the sweeper, and streams the log during long phases.
        beat = setInterval(() => {
            if (!finished && inflight === 0) void save();
        }, HEARTBEAT_MS);

        // Cancel: the controller sets cancel_requested; we notice within a couple of seconds.
        let rejectCancel: (e: Error) => void = () => {};
        const cancelGate = new Promise<never>((_, reject) => {
            rejectCancel = reject;
        });
        cancelGate.catch(() => {}); // never an unhandled rejection when nobody is racing it

        let checking = false;
        const checkCancel = async () => {
            if (cancelFlag || finished || checking) return;
            checking = true;
            try {
                const row = (await Deployment.find(deploymentId)) as DeploymentRow | null;
                if (!row || Number(row.cancel_requested) !== 1) return;

                cancelFlag = true;
                log += "\n==> Cancelling the deployment\n";
                await save();

                try {
                    const killed = await sshExec(target, cancelScript(site), 60_000);
                    const out = mask([killed.stdout, killed.stderr].filter(Boolean).join("\n").trim());
                    if (out) log += out + "\n";
                } catch (err) {
                    log += `Couldn't reach the server to stop the commands: ${err instanceof Error ? err.message : "unknown error"}\n`;
                }
                await save();

                // If the running phase ends by itself (it should, the command was killed), good.
                // If not, stop waiting for it.
                setTimeout(() => rejectCancel(new CancelError("Cancelled.")), CANCEL_GRACE_MS);
            } catch (err) {
                console.error(`Cancel check for deployment ${deploymentId} failed:`, err);
            } finally {
                checking = false;
            }
        };
        watcher = setInterval(() => void checkCancel(), CANCEL_POLL_MS);

        const installed = ((await SitePlugin.all()) as { site_id: number; plugin: string; status: string }[])
            .filter((r) => Number(r.site_id) === siteId && r.status === "installed")
            .map((r) => r.plugin);

        for (const phase of buildPhases(site, source, installed)) {
            if (cancelFlag) throw new CancelError("Cancelled.");

            log += `==> ${phase.title}\n`;
            await save();

            // Restarting the deployer's own services ends the process that is running this deploy.
            // Record the success first, or the row would be left "deploying" and later swept as failed.
            if (phase.restarts && self && !earlyDone) {
                earlyDone = true;
                log +=
                    "The deployer is restarting itself now. This deployment is recorded as successful before the restart, because the restart ends the process running it. Reload the page in a few seconds.\n";
                await save({ deploy_status: "success", deployed_at: nowIso() }, { status: "success", finished_at: nowIso() });
            }

            const result = await withDeadline(
                sshExec(target, phase.script, DEPLOY_TIMEOUT_MS),
                DEPLOY_TIMEOUT_MS + PHASE_GRACE_MS,
                phase.title,
                [cancelGate],
            );

            let stdout = result.stdout;

            // The pull phase prints the commit it landed on. Save it on the history
            // row and keep the marker lines out of the visible log.
            if (phase.capturesCommit && result.code === 0) {
                const found = extractCommit(stdout);
                stdout = found.clean;
                if (found.sha) {
                    try {
                        await Deployment.update(deploymentId, {
                            commit_sha: found.sha,
                            commit_message: mask(found.message),
                        });
                    } catch (err) {
                        console.error(`Couldn't save the commit for deployment ${deploymentId}:`, err);
                    }
                }
            }

            const out = mask([stdout, result.stderr].filter(Boolean).join("\n").trim());
            if (out) log += out + "\n";
            log += "\n";
            await save();

            if (result.code !== 0) {
                if (cancelFlag) throw new CancelError("Cancelled.");
                throw new Error(mask(lastLine(result.stderr, result.stdout)));
            }
        }

        finished = true;
        log += "Deployed successfully.\n";
        await save({ deploy_status: "success", deployed_at: nowIso() }, { status: "success", finished_at: nowIso() });
    } catch (err) {
        finished = true;

        if (err instanceof CancelError) {
            log +=
                "\nCANCELLED: the deployment was stopped. The deploy script rolled back if it was running; the code on the server may be partially updated, so deploy again before relying on it.\n";
            await save({ deploy_status: "cancelled" }, { status: "cancelled", finished_at: nowIso() });
        } else {
            const message = err instanceof Error ? err.message : "Deployment failed.";
            log += `\nFAILED: ${message}\n`;
            await save({ deploy_status: "failed" }, { status: "failed", finished_at: nowIso() });
        }
    } finally {
        finished = true;
        if (beat) clearInterval(beat);
        if (watcher) clearInterval(watcher);
        active.delete(deploymentId);
        // A slot is free: let the next queued deployment start without waiting for the poll.
        SiteDeployer.kick();
    }
}

// =====================================================================
// The queue runner
// =====================================================================

/**
 * Claims a queued deployment. The conditional update (status must still be
 * "queued") is what makes two processes unable to take the same row; after it
 * we read the row back and check it carries OUR runner id.
 */
async function claim(id: number): Promise<boolean> {
    const patch = { status: "deploying", runner: RUNNER_ID, started_at: nowIso(), heartbeat_at: nowIso() };

    try {
        await (Deployment as any).where("id", id).where("status", "queued").update(patch);
    } catch (err) {
        // The ORM has no conditional update: fall back to a plain one (safe with a single runner process).
        console.error(`Deploy queue: conditional claim of deployment ${id} failed, trying a plain update:`, err);
        try {
            const current = (await Deployment.find(id)) as DeploymentRow | null;
            if (!current || current.status !== "queued") return false;
            await Deployment.update(id, patch);
        } catch (err2) {
            console.error(
                `Deploy queue: couldn't claim deployment ${id}. Is the migration applied (runner, heartbeat_at columns)?`,
                err2,
            );
            return false;
        }
    }

    const row = (await Deployment.find(id)) as DeploymentRow | null;
    if (!row || row.status !== "deploying") return false;

    // Someone else won the race.
    if (row.runner && row.runner !== RUNNER_ID) return false;

    // The row is ours by status but the runner id wasn't saved: the column is missing from
    // Deployment.fillable. Carry on (fine with one runner process) but say so.
    if (!row.runner) {
        console.warn(
            "Deploy queue: deployments.runner was not saved. Add runner, heartbeat_at, queued_at and cancel_requested to Deployment.fillable.",
        );
    }

    return true;
}

/** Logs once at startup if the deployments table or model doesn't have the queue columns. */
async function selfCheck(): Promise<void> {
    try {
        await (Deployment as any).where("runner", "__check__").get();
        await (Deployment as any).where("heartbeat_at", "__check__").get();
        await (Deployment as any).where("queued_at", "__check__").get();
        await (Deployment as any).where("cancel_requested", 99).get();
        console.log(
            `Deploy queue: runner ${RUNNER_ID} started (runner ${RUNNER_ENABLED ? "on" : "OFF"}, max ${MAX_CONCURRENT} at once, self domain "${process.env.TYLIX_SELF_DOMAIN ?? ""}").`,
        );
    } catch (err) {
        console.error(
            "Deploy queue: the deployments table is missing the queue columns. Run the migration (cancel_requested, runner, queued_at, heartbeat_at). Deploys will stay queued until you do.",
            err,
        );
    }
}

let lastWhy = "";

/** Logs why queued work isn't starting, only when the reason changes (so a stuck queue explains itself). */
function why(reason: string): void {
    if (reason === lastWhy) return;
    lastWhy = reason;
    if (reason) console.log(`Deploy queue: waiting, ${reason}`);
}

let ticking = false;

async function tick(): Promise<void> {
    if (!RUNNER_ENABLED || ticking) return;
    ticking = true;

    try {
        const queued = ((await Deployment.where("status", "queued").get()) as unknown as DeploymentRow[]).sort(
            (a, b) => Number(a.id) - Number(b.id),
        );
        if (queued.length === 0) {
            why("");
            return;
        }

        const running = (await Deployment.where("status", "deploying").get()) as unknown as DeploymentRow[];

        const infoCache = new Map<number, { server_id: number; domain: string } | null>();
        const infoOf = async (siteId: number) => {
            if (!infoCache.has(siteId)) {
                const site = (await Site.find(siteId)) as { server_id: number; domain: string } | null;
                infoCache.set(siteId, site ? { server_id: Number(site.server_id), domain: s(site.domain) } : null);
            }
            return infoCache.get(siteId) ?? null;
        };

        // What is running right now, anywhere (this process or another).
        const busy: { server_id: number; self: boolean }[] = [];
        for (const r of running) {
            const info = await infoOf(Number(r.site_id));
            if (info) busy.push({ server_id: info.server_id, self: isSelfDeploy(info.domain) });
        }

        let waitingForSelf = false;
        let begun = 0;
        let reason = "";

        for (const cand of queued) {
            if (running.length >= MAX_CONCURRENT) {
                reason = `the safety limit of ${MAX_CONCURRENT} simultaneous deploys is reached`;
                break;
            }

            const info = await infoOf(Number(cand.site_id));
            if (!info) {
                await SiteDeployer.closeOrphan(cand.id, "failed", "FAILED: the site no longer exists.", ["queued"]);
                continue;
            }

            const self = isSelfDeploy(info.domain);

            if (self) {
                // The deployer restarts itself, so it runs alone and everything else waits for it.
                if (running.length > 0) {
                    waitingForSelf = true;
                    reason = `deployment ${cand.id} is the deployer itself and ${running.length} other deploy(s) are still running`;
                    continue;
                }
            } else {
                if (waitingForSelf) {
                    reason = `deployment ${cand.id} is held so the deployer's own deploy can go first`;
                    continue; // don't let new work starve a queued self deploy
                }
                if (busy.some((b) => b.self)) {
                    reason = `the deployer is deploying itself`;
                    continue;
                }
            }

            if (busy.some((b) => b.server_id === info.server_id)) {
                reason = `deployment ${cand.id} waits for another deploy on server ${info.server_id}`;
                continue; // one deploy per server
            }

            if (!(await claim(cand.id))) {
                reason = `deployment ${cand.id} could not be claimed (see the errors above)`;
                continue;
            }

            begun++;
            busy.push({ server_id: info.server_id, self });
            running.push(cand);

            void execute(cand.id, Number(cand.site_id)).catch((err) => {
                console.error(`Deployment ${cand.id} crashed:`, err);
            });
        }

        why(begun === 0 ? reason : "");
    } catch (err) {
        console.error("Deploy queue tick failed:", err);
    } finally {
        ticking = false;
    }
}

// =====================================================================
// Public API
// =====================================================================

export class SiteDeployer {
    /**
     * Queues a deployment. Returns the new history row (status "queued").
     * The runner picks it up within a couple of seconds.
     */
    static async enqueue(siteId: number, userId: number): Promise<DeploymentRow | null> {
        const site = (await Site.find(siteId)) as DeployRow | null;
        if (!site) return null;

        await Site.update(siteId, { deploy_status: "queued", deploy_log: "" });

        const row = (await Deployment.create({
            site_id: siteId,
            user_id: userId,
            team_id: Number(site.team_id),
            status: "queued",
            log: "",
            branch: s(site.branch),
            commit_sha: "",
            commit_message: "",
            cancel_requested: 0,
            runner: "",
            queued_at: nowIso(),
            started_at: "",
            finished_at: "",
            heartbeat_at: "",
        })) as DeploymentRow | null;

        SiteDeployer.kick();
        return row;
    }

    /** Backward compatible: queues a deployment as the site's creator. */
    static start(siteId: number): void {
        void (async () => {
            try {
                const site = (await Site.find(siteId)) as DeployRow | null;
                if (site) await SiteDeployer.enqueue(siteId, Number(site.user_id));
            } catch (err) {
                console.error(`Couldn't queue a deploy of site ${siteId}:`, err);
            }
        })();
    }

    /** Wakes the runner now instead of waiting for the next poll. */
    static kick(): void {
        if (RUNNER_ENABLED) setTimeout(() => void tick(), 0);
    }

    /**
     * Closes a queued or running deployment that nothing is working on (or
     * that is being cancelled before it started). `from` limits which statuses
     * may be closed, so a cancel can't close a deployment that just started.
     * Also settles the site's deploy_status. Returns true if it closed one.
     */
    static async closeOrphan(
        deploymentId: number,
        status: "failed" | "cancelled",
        note: string,
        from: string[] = ["queued", "deploying"],
    ): Promise<boolean> {
        try {
            const row = (await Deployment.find(deploymentId)) as DeploymentRow | null;
            if (!row || !from.includes(row.status)) return false;

            const site = (await Site.find(row.site_id)) as { id: number; deploy_status: string; deploy_log: string } | null;
            const base = s(site?.deploy_log) || s(row.log);
            const log = clip((base ? base + "\n" : "") + note + "\n");

            await Deployment.update(deploymentId, { status, log, finished_at: nowIso() });

            if (site && (site.deploy_status === "queued" || site.deploy_status === "deploying")) {
                await Site.update(site.id, { deploy_status: status, deploy_log: log });
            }

            return true;
        } catch (err) {
            console.error(`Couldn't close deployment ${deploymentId}:`, err);
            return false;
        }
    }

    /**
     * Fails deployments whose process died (no heartbeat for STALE_MS), and
     * resets sites left on "queued"/"deploying" with nothing behind them.
     * Safe to run from any process: a live deploy keeps its heartbeat fresh,
     * and deployments this process is running are skipped outright.
     */
    static async sweepStale(): Promise<number> {
        let closed = 0;

        try {
            const running = (await Deployment.where("status", "deploying").get()) as unknown as DeploymentRow[];

            for (const row of running) {
                if (active.has(row.id)) continue;

                // Proof of life = the newest of: the deployment's heartbeat, its start, and the site row's
                // own activity while that site is deploying. The site row is saved on every heartbeat too,
                // so this still works if heartbeat_at is missing from Deployment.fillable.
                const site = (await Site.find(row.site_id)) as { deploy_status: string; updated_at: string; deploy_log: string } | null;
                const siteBeat = site && site.deploy_status === "deploying" ? parseTime(site.updated_at) : NaN;
                const beat = Math.max(
                    parseTime(row.heartbeat_at) || 0,
                    parseTime(row.started_at) || 0,
                    parseTime(row.queued_at) || 0,
                    Number.isFinite(siteBeat) ? siteBeat : 0,
                );
                if (beat > 0 && Date.now() - beat < STALE_MS) continue;

                // Re-read right before writing: it may have finished a moment ago.
                const fresh = (await Deployment.find(row.id)) as DeploymentRow | null;
                if (!fresh || fresh.status !== "deploying") continue;

                const cancelled = Number(fresh.cancel_requested) === 1;

                // If the last stage was a restart, the deploy most likely worked and the restart ended the process.
                const text = s(site?.deploy_log) || s(fresh.log);
                const stages = text.split("\n").filter((l) => l.startsWith("==> "));
                const lastStage = stages.length > 0 ? stages[stages.length - 1] : "";
                const restartHint = /==> (Restarting|Reloading)/.test(lastStage)
                    ? " The last stage was a restart, so the deploy itself most likely worked and the restart ended the process running it. If this was the deployer's own site, set TYLIX_SELF_DOMAIN so this is recorded as a success."
                    : "";

                const ok = await SiteDeployer.closeOrphan(
                    row.id,
                    cancelled ? "cancelled" : "failed",
                    cancelled
                        ? "CANCELLED: the process running this deployment was gone, so it was closed."
                        : "FAILED: this deployment stopped reporting progress (the app was probably restarted while it ran). Marked as failed automatically." + restartHint,
                    ["deploying"],
                );
                if (ok) closed++;
            }

            // Sites stuck on queued/deploying with no active deployment row behind them.
            const activeRows = [
                ...((await Deployment.where("status", "queued").get()) as unknown as DeploymentRow[]),
                ...((await Deployment.where("status", "deploying").get()) as unknown as DeploymentRow[]),
            ];
            const withWork = new Set(activeRows.map((d) => Number(d.site_id)));

            const sites = (await Site.all()) as {
                id: number;
                deploy_status: string;
                deploy_log: string;
                updated_at: string;
            }[];

            for (const site of sites) {
                if (site.deploy_status !== "deploying" && site.deploy_status !== "queued") continue;
                if (withWork.has(Number(site.id))) continue;

                const age = Date.now() - parseTime(site.updated_at);
                if (Number.isFinite(age) && age < STALE_MS) continue;

                await Site.update(site.id, {
                    deploy_status: "failed",
                    deploy_log: clip(s(site.deploy_log) + "\nFAILED: this deployment was lost (no record of it was running). Marked as failed automatically.\n"),
                });
                closed++;
            }
        } catch (err) {
            console.error("Stale deploy sweep failed:", err);
        }

        return closed;
    }
}

// =====================================================================
// Background loops
// =====================================================================

async function interruptActive(): Promise<void> {
    const jobs = [...active.values()].map((a) => a.interrupt("The app was restarted while this deployment was running."));
    await Promise.race([Promise.allSettled(jobs), new Promise((resolve) => setTimeout(resolve, 4000))]);
}

let started = false;

/**
 * Starts the sweeper (always) and the queue runner (unless TYLIX_DEPLOY_RUNNER=off).
 * Importing this file starts them once per process.
 */
export function startDeployRunner(): void {
    if (started) return;
    started = true;

    void selfCheck();
    void SiteDeployer.sweepStale();
    const sweep = setInterval(() => void SiteDeployer.sweepStale(), SWEEP_MS);
    sweep.unref?.();

    if (RUNNER_ENABLED) {
        const poll = setInterval(() => void tick(), POLL_MS);
        poll.unref?.();
        void tick();
    }

    // A clean restart records its running deployments as failed immediately,
    // instead of leaving them for the sweeper. We only exit ourselves if nobody
    // else is handling the signal.
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
        process.once(sig, () => {
            void interruptActive().finally(() => {
                if (process.listenerCount(sig) === 0) process.exit(0);
            });
        });
    }
}

startDeployRunner();