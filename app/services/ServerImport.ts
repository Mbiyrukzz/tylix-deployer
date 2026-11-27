/**
 * Imports what already runs on a server (set up by hand, or by another panel
 * such as Vito) into Flux, without reinstalling or moving anything.
 *
 *   scan(server)                read-only: nginx sites, PHP-FPM pools, MySQL
 *                               databases, Supervisor programs and crontabs
 *   run(server, picks, actor)   adopts what was picked, then reports per item
 *
 * WHAT IMPORTING CHANGES ON THE SERVER
 *
 *   sites      the nginx file moves to /etc/nginx/sites-available/<domain>.conf
 *              (content unchanged, the original is kept in tylix-backups) so
 *              the nginx editor, SSL and redirects can find it; nginx -t must
 *              pass or it is put back. PHP sites also get Flux's own PHP-FPM
 *              pool for their user (a new pool next to the existing ones), so
 *              config Flux writes later (SSL, plugins) has a socket to talk to.
 *              Optionally the git remote is switched from SSH to HTTPS so
 *              deploys use the team's GitHub / GitLab connection.
 *   databases  nothing: only the records are added
 *   workers    the program is rewritten as tylix-worker-<id> and the old
 *              program is stopped and removed (the new one starts first)
 *   cron       the line moves from the user's crontab to
 *              /etc/cron.d/tylix-cron-<id> (written first, then removed)
 *
 * WHICH SITES CAN BE IMPORTED
 *
 * Flux finds a site's files at /home/<user>/<domain> everywhere (deploys,
 * logs, terminal, SSL), so only sites whose nginx root is that folder (or a
 * folder inside it, the web directory) are offered. That is also the layout
 * Vito uses. The folder must belong to <user>, a normal account (uid >= 1000).
 *
 * Imported sites may share their unix user (Vito runs every site as "vito").
 * Sites are marked origin = "import", and SiteDestroyer then only removes that
 * site's own nginx file, certificate and folder, never the user. Because Flux
 * names app services after the user (app-<user>), a Node site can only be
 * imported when no other Flux site uses its user. A site Flux created never
 * shares its user with an imported one: deleting it removes the whole user.
 *
 * Every value read from the server is checked against the same strict
 * patterns as values typed into Flux before it reaches a script or a record.
 */

import { createHash } from "node:crypto";
import { Site } from "../models/Site.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { DbUser } from "../models/DbUser.js";
import { ServerDatabase } from "../models/ServerDatabase.js";
import { ServerWorker } from "../models/ServerWorker.js";
import { ServerCronJob } from "../models/ServerCronJob.js";
import { CryptoService } from "./CryptoService.js";
import { sshExec } from "./Ssh.js";
import { shellScript, serverTarget } from "./Shell.js";
import { getType } from "./SiteTypes.js";
import { fpmPool } from "./SiteDeployer.js";
import { teamIdOfRow } from "./TeamScope.js";
import * as CronFiles from "./CronFiles.js";
import * as WorkerFiles from "./WorkerFiles.js";
import { checkDatabaseName, checkDbUserName } from "../validators/DatabaseValidator.js";

// ---- types ----------------------------------------------------------------

export interface ImportServer {
    id: number;
    user_id: number;
    team_id: number | null;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
    ssh_host_key?: string | null;
    [key: string]: unknown;
}

export type ImportRuntime = "php" | "node" | "static";

export interface ScannedSite {
    key: string;
    domain: string;
    aliases: string[];
    user: string;
    root: string;
    webDirectory: string;
    vhost: string;
    enabledPath: string;
    runtime: ImportRuntime;
    type: string;
    types: string[];
    phpVersion: string;
    port: number;
    repository: string;
    branch: string;
    gitHost: "github" | "gitlab" | "";
    remote: string;
    remoteIsSsh: boolean;
    sourceControlId: number;
    ssl: { mode: "none" | "letsencrypt" | "custom"; cert: string; key: string; expiresAt: string };
    pool: "exists" | "create" | "conflict" | "";
    importable: boolean;
    reason: string;
    notes: string[];
}

export interface ScannedDatabase {
    key: string;
    name: string;
    charset: string;
    collation: string;
    owner: string;
    importable: boolean;
    reason: string;
    notes: string[];
}

export interface ScannedWorker {
    key: string;
    name: string;
    file: string;
    program: string;
    command: string;
    directory: string;
    user: string;
    processes: number;
    importable: boolean;
    reason: string;
}

export interface ScannedCron {
    key: string;
    user: string;
    schedule: string;
    command: string;
    line: string;
    importable: boolean;
    reason: string;
}

export interface ScanResult {
    sites: ScannedSite[];
    databases: ScannedDatabase[];
    workers: ScannedWorker[];
    cron: ScannedCron[];
    phpVersions: string[];
    mysql: { available: boolean; error: string };
    scannedAt: string;
}

export interface SitePick {
    key: string;
    type?: string;
    php_version?: string;
    source_control_id?: number;
    https_remote?: boolean;
}

export interface ImportPicks {
    sites: SitePick[];
    databases: string[];
    workers: string[];
    cron: string[];
}

export interface ItemReport {
    kind: "site" | "database" | "worker" | "cron";
    key: string;
    name: string;
    ok: boolean;
    error: string;
    notes: string[];
    id: number;
}

export class ImportError extends Error {
    constructor(message: string, public status = 422) {
        super(message);
    }
}

// ---- patterns ---------------------------------------------------------------

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const USER = /^[a-z][a-z0-9_-]{0,31}$/;
const RESERVED_USERS = ["root", "www", "www-data", "nginx", "ubuntu", "admin", "tylix", "mysql", "postgres", "redis"];
const REL_PATH = /^[A-Za-z0-9._\/-]+$/;
const ABS_PATH = /^\/[A-Za-z0-9._\/@+-]*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,100}$/;
const UNIX_USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
const WORKER_DIR = /^\/[A-Za-z0-9_.\/-]*$/;
const PHP_VERSION = /^\d\.\d$/;

const TYPES_BY_RUNTIME: Record<ImportRuntime, string[]> = {
    php: ["laravel", "php", "wordpress"],
    node: ["nodejs", "nextjs", "nuxt", "tylix"],
    static: ["static"],
};

const SYSTEM_DATABASES = ["mysql", "sys", "information_schema", "performance_schema"];
const SYSTEM_DB_USERS = ["root", "mysql", "mariadb.sys", "debian-sys-maint", "mysql.sys", "mysql.session", "mysql.infoschema", "PUBLIC", ""];

const SCAN_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 90_000;

const hasControl = (v: string) => [...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const hash = (v: string) => createHash("sha1").update(v).digest("hex").slice(0, 16);
const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64");
const unb64 = (v: string) => Buffer.from(v, "base64").toString("utf8");
const normSock = (p: string) => p.replace(/^\/var\/run\//, "/run/");

// ---- remote output ----------------------------------------------------------

/** Each record the scan scripts print is one line: @@kind<TAB>name<TAB>base64. */
interface Record_ {
    kind: string;
    name: string;
    body: string;
}

function records(stdout: string): Record_[] {
    const out: Record_[] = [];
    for (const line of stdout.split("\n")) {
        if (!line.startsWith("@@")) continue;
        const [kind, name = "", body = ""] = line.slice(2).split("\t");
        out.push({ kind, name, body: body ? unb64(body.trim()) : "" });
    }
    return out;
}

const EMIT = `
emit() { printf '@@%s\\t%s\\t' "$1" "$2"; }
nl() { printf '\\n'; }
`;

const SCAN_SCRIPT = `${EMIT}
for f in /etc/nginx/sites-enabled/*; do
  [ -e "$f" ] || continue
  emit nginx "$f|$(readlink -f "$f")"; $SUDO cat "$f" 2>/dev/null | base64 -w0; nl
done
for f in /etc/supervisor/conf.d/*.conf; do
  [ -f "$f" ] || continue
  emit supervisor "$f"; $SUDO cat "$f" 2>/dev/null | base64 -w0; nl
done
for d in /etc/php/*/fpm; do
  [ -d "$d" ] || continue
  emit php "$(basename "$(dirname "$d")")"; nl
  for f in "$d"/pool.d/*.conf; do
    [ -f "$f" ] || continue
    emit pool "$f"; $SUDO cat "$f" 2>/dev/null | base64 -w0; nl
  done
done
getent passwd | while IFS=: read -r name _ uid _ _ home _; do
  if [ "$name" = root ] || { [ "$uid" -ge 1000 ] && [ "$uid" -lt 65534 ]; }; then
    emit user "$name|$uid|$home"; nl
    if out="$($SUDO crontab -l -u "$name" 2>/dev/null)"; then
      emit cron "$name"; printf '%s\\n' "$out" | base64 -w0; nl
    fi
  fi
done
if command -v mysql >/dev/null 2>&1; then
  if out="$($SUDO mysql -N -B -e "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA" 2>&1)"; then
    emit mysql-dbs ""; printf '%s' "$out" | base64 -w0; nl
    emit mysql-users ""; $SUDO mysql -N -B -e "SELECT User, Host FROM mysql.user" 2>/dev/null | base64 -w0; nl
    emit mysql-grants ""; $SUDO mysql -N -B -e "SELECT User, Host, Db FROM mysql.db" 2>/dev/null | base64 -w0; nl
  else
    emit mysql-error ""; printf '%s' "$out" | tail -n 3 | base64 -w0; nl
  fi
else
  emit mysql-missing ""; nl
fi
exit 0
`;

/** Phase two: looks inside each candidate site folder. LIST_B64 holds key<TAB>user<TAB>root<TAB>cert lines. */
const INSPECT_SCRIPT = `${EMIT}
TAB="$(printf '\\t')"
printf '%s' "$LIST_B64" | base64 -d | while IFS="$TAB" read -r K U R C; do
  [ -n "$K" ] || continue
  emit site "$K"
  {
    if [ -d "$R" ]; then echo "exists=1"; else echo "exists=0"; fi
    echo "owner=$(stat -c %U "$R" 2>/dev/null || true)"
    echo "uid=$(id -u "$U" 2>/dev/null || true)"
    for m in artisan composer.json wp-config.php wp-load.php package.json index.php index.html .env; do
      if $SUDO test -e "$R/$m"; then echo "has=$m"; fi
    done
    if $SUDO test -f "$R/.git/HEAD"; then
      echo "head=$($SUDO cat "$R/.git/HEAD" 2>/dev/null | head -n 1)"
      echo "remote=$($SUDO git config -f "$R/.git/config" --get remote.origin.url 2>/dev/null || true)"
    fi
    if $SUDO test -f "$R/package.json"; then
      echo "pkg=$($SUDO head -c 65536 "$R/package.json" | base64 -w0)"
    fi
    if [ -n "$C" ] && $SUDO test -f "$C"; then
      echo "certend=$($SUDO openssl x509 -enddate -noout -in "$C" 2>/dev/null | cut -d= -f2)"
    fi
  } | base64 -w0
  nl
done
exit 0
`;

/** Reads each site's .env and the DB lines of wp-config.php. LIST_B64 holds key<TAB>root lines. */
const SECRETS_SCRIPT = `${EMIT}
TAB="$(printf '\\t')"
printf '%s' "$LIST_B64" | base64 -d | while IFS="$TAB" read -r K R; do
  [ -n "$K" ] || continue
  emit env "$K"; if $SUDO test -f "$R/.env"; then $SUDO head -c 65536 "$R/.env" | base64 -w0; fi; nl
  emit wp "$K"; if $SUDO test -f "$R/wp-config.php"; then $SUDO grep -E "DB_(NAME|USER|PASSWORD)" "$R/wp-config.php" 2>/dev/null | head -c 4096 | base64 -w0; fi; nl
done
exit 0
`;

/** Moves the nginx file to Flux's name, adds Flux's PHP-FPM pool, optionally switches the git remote. */
const ADOPT_SITE_SCRIPT = `
DST="/etc/nginx/sites-available/$DOMAIN.conf"
DSTLINK="/etc/nginx/sites-enabled/$DOMAIN.conf"
BK="/etc/nginx/tylix-backups"
[ -d "$SITE_ROOT" ] || { echo "The site folder $SITE_ROOT is not there any more." >&2; exit 4; }
$SUDO test -e "$SRC" || { echo "The nginx file $SRC is not there any more. Scan again." >&2; exit 4; }

if [ "$SRC" != "$DST" ] || [ "$LINK" != "$DSTLINK" ]; then
  if ! PRE="$($SUDO nginx -t 2>&1)"; then
    echo "$PRE" >&2
    echo "nginx -t already fails on this server, before anything was moved. Fix that first, then import again." >&2
    exit 5
  fi
  if [ "$SRC" != "$DST" ] && $SUDO test -e "$DST"; then
    echo "$DST already exists, so this site's nginx file can't be moved there. Remove or rename it, then scan again." >&2
    exit 4
  fi
  $SUDO mkdir -p "$BK"
  SAVED="$BK/import-$(basename "$SRC")-$(date +%Y%m%d%H%M%S)"
  $SUDO cp -p "$SRC" "$SAVED"
  WAS_LINK=0
  if [ -L "$LINK" ]; then WAS_LINK=1; fi
  if [ "$SRC" != "$DST" ]; then $SUDO cp -p "$SRC" "$DST"; fi
  $SUDO rm -f "$LINK"
  $SUDO ln -sfn "$DST" "$DSTLINK"
  if ! OUT="$($SUDO nginx -t 2>&1)"; then
    $SUDO rm -f "$DSTLINK"
    if [ "$SRC" != "$DST" ]; then $SUDO rm -f "$DST"; fi
    if [ "$WAS_LINK" = 1 ]; then $SUDO ln -sfn "$SRC" "$LINK"; else $SUDO cp -p "$SAVED" "$LINK"; fi
    echo "$OUT" >&2
    echo "nginx rejected the config at its new name, so it was put back as it was." >&2
    exit 3
  fi
  if [ "$SRC" != "$DST" ] && $SUDO test -e "$SRC"; then $SUDO rm -f "$SRC"; fi
  $SUDO systemctl reload nginx
  echo "nginx: moved $SRC to $DST (content unchanged, original saved as $SAVED)"
else
  echo "nginx: already at $DST"
fi

if [ -n "$POOL_B64" ]; then
  POOL="/etc/php/$PHP_VERSION/fpm/pool.d/$SITE_USER.conf"
  if $SUDO test -f "$POOL"; then
    echo "php-fpm: $POOL already exists, left as it is"
  else
    printf '%s' "$POOL_B64" | base64 -d | $SUDO tee "$POOL" >/dev/null
    if $SUDO "php-fpm$PHP_VERSION" -t >/dev/null 2>&1; then
      if $SUDO systemctl reload "php$PHP_VERSION-fpm"; then
        echo "php-fpm: added the pool $SITE_USER (php$PHP_VERSION-fpm-$SITE_USER.sock); existing pools untouched"
      else
        echo "WARN: The PHP-FPM pool for $SITE_USER was written but php$PHP_VERSION-fpm didn't reload. Reload it from the server's Services."
      fi
    else
      $SUDO rm -f "$POOL"
      echo "WARN: PHP-FPM refused a new pool for $SITE_USER, so none was added. The site keeps using its current pool."
    fi
  fi
fi

if [ -n "$REMOTE_URL" ]; then
  if as_user git -C "$SITE_ROOT" remote set-url origin "$REMOTE_URL"; then
    echo "git: origin is now $REMOTE_URL"
  else
    echo "WARN: The git remote couldn't be changed, so deploys still use the old one."
  fi
fi
exit 0
`;

// ---- parsers ----------------------------------------------------------------

interface Directive {
    name: string;
    args: string[];
    /** Block headers around the directive, e.g. ["server", "location ~ \\.php$"]. */
    ctx: string[];
    /** Which top-level server block (0, 1, ...), -1 when outside one. */
    server: number;
}

/** A small nginx config reader: statements, blocks and their nesting. Comments and quotes are handled. */
export function parseNginx(text: string): Directive[] {
    const out: Directive[] = [];
    const stack: string[] = [];
    let serverIndex = -1;
    let currentServer = -1;
    let tokens: string[] = [];
    let token = "";
    let quote = "";

    const endToken = () => {
        if (token !== "") tokens.push(token);
        token = "";
    };

    for (let i = 0; i < text.length; i++) {
        const c = text[i];

        if (quote) {
            if (c === "\\" && i + 1 < text.length) {
                token += text[++i];
            } else if (c === quote) {
                quote = "";
            } else {
                token += c;
            }
            continue;
        }

        if (c === "#") {
            while (i < text.length && text[i] !== "\n") i++;
            endToken();
            continue;
        }
        if (c === '"' || c === "'") {
            quote = c;
            continue;
        }
        if (/\s/.test(c)) {
            endToken();
            continue;
        }
        if (c === ";") {
            endToken();
            if (tokens.length > 0) {
                out.push({ name: tokens[0], args: tokens.slice(1), ctx: [...stack], server: stack.length > 0 ? currentServer : -1 });
            }
            tokens = [];
            continue;
        }
        if (c === "{") {
            endToken();
            const header = tokens.join(" ");
            if (stack.length === 0 && tokens[0] === "server") {
                serverIndex++;
                currentServer = serverIndex;
            }
            stack.push(header);
            tokens = [];
            continue;
        }
        if (c === "}") {
            endToken();
            tokens = [];
            stack.pop();
            continue;
        }
        token += c;
    }
    return out;
}

interface VhostInfo {
    names: string[];
    roots: string[];
    ssl: boolean;
    cert: string;
    key: string;
    phpSocket: string;
    port: number;
}

export function readVhost(text: string): VhostInfo {
    const ds = parseNginx(text);
    const inServer = (d: Directive) => d.server >= 0 && d.ctx.length >= 1 && d.ctx[0].startsWith("server");
    const serverLevel = (d: Directive) => inServer(d) && d.ctx.length === 1;

    const names: string[] = [];
    for (const d of ds) {
        if (d.name !== "server_name" || !inServer(d)) continue;
        for (const n of d.args) {
            const v = n.toLowerCase();
            if (v === "_" || v === "localhost" || v.startsWith("~") || v.includes("*")) continue;
            if (!names.includes(v)) names.push(v);
        }
    }

    // A server-level root wins; a root inside "location /" is the fallback.
    let roots = ds.filter((d) => d.name === "root" && serverLevel(d)).map((d) => d.args[0] ?? "");
    if (roots.length === 0) {
        roots = ds
            .filter((d) => d.name === "root" && inServer(d) && d.ctx.length === 2 && /^location\s+\/$/.test(d.ctx[1]))
            .map((d) => d.args[0] ?? "");
    }
    roots = [...new Set(roots.filter(Boolean).map((r) => r.replace(/\/+$/, "")))];

    const listen = ds.filter((d) => d.name === "listen" && inServer(d)).flatMap((d) => d.args);
    const cert = ds.find((d) => d.name === "ssl_certificate" && inServer(d))?.args[0] ?? "";
    const key = ds.find((d) => d.name === "ssl_certificate_key" && inServer(d))?.args[0] ?? "";
    const ssl = cert !== "" || listen.some((a) => a === "ssl" || /(^|:)443$/.test(a));

    const fastcgi = ds.find((d) => d.name === "fastcgi_pass" && inServer(d))?.args[0] ?? "";
    const phpSocket = fastcgi.startsWith("unix:") ? normSock(fastcgi.slice(5)) : "";

    let port = 0;
    for (const d of ds) {
        if (d.name !== "proxy_pass" || !inServer(d)) continue;
        const m = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})(?:\/|$)/.exec(d.args[0] ?? "");
        if (m) {
            port = Number(m[1]);
            break;
        }
    }

    return { names, roots, ssl, cert, key, phpSocket, port };
}

/** Supervisor .ini: one or more [program:x] sections with key = value lines. */
export function parseSupervisor(text: string): { programs: { name: string; values: Record<string, string> }[]; continued: boolean } {
    const programs: { name: string; values: Record<string, string> }[] = [];
    let current: { name: string; values: Record<string, string> } | null = null;
    let continued = false;

    for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "");
        if (/^\s*([;#]|$)/.test(line)) continue;
        const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
        if (section) {
            const m = /^program:(.+)$/.exec(section[1].trim());
            current = m ? { name: m[1].trim(), values: {} } : null;
            if (current) programs.push(current);
            continue;
        }
        if (/^\s+\S/.test(line)) {
            continued = true;
            continue;
        }
        const kv = /^\s*([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
        if (kv && current) current.values[kv[1].toLowerCase()] = kv[2].trim();
    }
    return { programs, continued };
}

/** One crontab line, split into schedule and command. Null for blank lines, comments and VAR=value. */
export function parseCronLine(line: string): { schedule: string; command: string } | null {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(t)) return null;

    if (t.startsWith("@")) {
        const m = /^(@\w+)\s+(.+)$/.exec(t);
        return m ? { schedule: m[1], command: m[2].trim() } : { schedule: t, command: "" };
    }
    const parts = t.split(/\s+/);
    if (parts.length < 6) return { schedule: parts.join(" "), command: "" };
    const schedule = parts.slice(0, 5).join(" ");
    const command = t.replace(/^(\S+\s+){5}/, "").trim();
    return { schedule, command };
}

/** owner/repo and host from a git remote (https, scp-style ssh or ssh://). */
export function parseRemote(url: string): { host: "github" | "gitlab" | ""; repo: string; ssh: boolean; other: string } {
    const u = url.trim();
    let host = "";
    let path = "";
    let ssh = false;

    let m = /^https?:\/\/(?:[^@\/]+@)?([^\/:]+)(?::\d+)?\/(.+)$/.exec(u);
    if (m) {
        host = m[1];
        path = m[2];
    } else if ((m = /^ssh:\/\/(?:[^@\/]+@)?([^\/:]+)(?::\d+)?\/(.+)$/.exec(u))) {
        host = m[1];
        path = m[2];
        ssh = true;
    } else if ((m = /^(?:[^@\/]+@)?([^\/:]+):(.+)$/.exec(u))) {
        host = m[1];
        path = m[2];
        ssh = true;
    }

    const repo = path.replace(/\.git$/, "").replace(/\/+$/, "");
    const kind = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : "";
    return { host: kind, repo: REPO.test(repo) ? repo : "", ssh, other: kind ? "" : host };
}

/** KEY=value pairs from a .env file (quotes removed). */
export function parseEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split("\n")) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
        if (!m) continue;
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, "");
        out[m[1]] = v;
    }
    return out;
}

/** DB_NAME / DB_USER / DB_PASSWORD from the define() lines of wp-config.php. */
export function parseWpConfig(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /define\s*\(\s*['"](DB_NAME|DB_USER|DB_PASSWORD)['"]\s*,\s*(['"])((?:\\.|(?!\2).)*)\2\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out[m[1]] = m[3].replace(/\\(.)/g, "$1");
    return out;
}

const unescapeMysqlDb = (db: string) => db.replace(/\\([_%\\])/g, "$1");

function kvLines(text: string): { one: Record<string, string>; many: Record<string, string[]> } {
    const one: Record<string, string> = {};
    const many: Record<string, string[]> = {};
    for (const line of text.split("\n")) {
        const i = line.indexOf("=");
        if (i <= 0) continue;
        const k = line.slice(0, i);
        const v = line.slice(i + 1);
        one[k] = v;
        (many[k] ||= []).push(v);
    }
    return { one, many };
}

function toIso(certEnd: string): string {
    const t = Date.parse(certEnd);
    return Number.isNaN(t) ? "" : new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---- helpers ----------------------------------------------------------------

interface FluxSite {
    id: number;
    server_id: number;
    domain: string;
    isolated_user: string;
    type: string;
    origin?: string | null;
    [key: string]: unknown;
}

async function fluxSitesOn(serverId: number): Promise<FluxSite[]> {
    return ((await Site.all()) as FluxSite[]).filter((s) => Number(s.server_id) === serverId);
}

async function teamSourceControls(teamId: number): Promise<{ id: number; kind: string }[]> {
    const rows = (await SourceProvider.all()) as { id: number; kind: string; user_id: number; team_id?: number | null }[];
    const out: { id: number; kind: string }[] = [];
    for (const r of rows) {
        if ((await teamIdOfRow(r)) === teamId) out.push({ id: Number(r.id), kind: String(r.kind) });
    }
    return out;
}

function asRootSh(sshUser: string, script: string): string {
    return `${sshUser === "root" ? "" : "sudo -n "}sh -c ${WorkerFiles.sq(script)}`;
}

function lastLine(stderr: string, stdout: string): string {
    const lines = (stderr.trim() || stdout.trim()).split("\n").filter((l) => l.trim() !== "");
    return (lines[lines.length - 1] ?? "The command failed.").slice(0, 300);
}

/** Error lines first, then "WARN:" lines, as notes for the report. */
function warnings(stdout: string): string[] {
    return stdout
        .split("\n")
        .filter((l) => l.startsWith("WARN: "))
        .map((l) => l.slice(6).trim());
}

// ---- scan -------------------------------------------------------------------

export const ServerImport = {
    async scan(server: ImportServer): Promise<ScanResult> {
        const target = serverTarget(server as never);
        const teamId = Number(server.team_id);

        const first = await sshExec(target, shellScript({}, SCAN_SCRIPT), SCAN_TIMEOUT_MS);
        if (first.code === 255) throw new ImportError("Couldn't connect to the server over SSH.", 502);
        if (first.code !== 0) throw new ImportError(`The scan failed: ${lastLine(first.stderr, first.stdout)}`, 502);

        const recs = records(first.stdout);
        const flux = await fluxSitesOn(server.id);
        const fluxDomains = new Set(flux.map((s) => s.domain));
        const sources = await teamSourceControls(teamId);

        const phpVersions = recs.filter((r) => r.kind === "php" && PHP_VERSION.test(r.name)).map((r) => r.name).sort();
        const users = new Map<string, { uid: number; home: string }>();
        for (const r of recs.filter((x) => x.kind === "user")) {
            const [name, uid, home] = r.name.split("|");
            users.set(name, { uid: Number(uid), home: home ?? "" });
        }

        // PHP-FPM pools: file, pool names and sockets.
        const pools = recs
            .filter((r) => r.kind === "pool")
            .map((r) => {
                const names = [...r.body.matchAll(/^\s*\[([^\]]+)\]/gm)].map((m) => m[1].trim());
                const listen = [...r.body.matchAll(/^\s*listen\s*=\s*(\S+)/gm)].map((m) => normSock(m[1].trim()));
                return { file: r.name, names, listen };
            });

        // ---- sites ----
        const sites: ScannedSite[] = [];
        const seenDomains = new Set<string>();

        for (const r of recs.filter((x) => x.kind === "nginx")) {
            const [enabledPath, real] = r.name.split("|");
            const info = readVhost(r.body);
            const label = enabledPath.split("/").pop() || enabledPath;

            const site: ScannedSite = {
                key: "",
                domain: info.names[0] ?? label,
                aliases: [],
                user: "",
                root: "",
                webDirectory: "",
                vhost: real || enabledPath,
                enabledPath,
                runtime: info.port ? "node" : info.phpSocket ? "php" : "static",
                type: "",
                types: [],
                phpVersion: "",
                port: info.port,
                repository: "",
                branch: "",
                gitHost: "",
                remote: "",
                remoteIsSsh: false,
                sourceControlId: 0,
                ssl: { mode: "none", cert: info.cert, key: info.key, expiresAt: "" },
                pool: "",
                importable: false,
                reason: "",
                notes: [],
            };
            site.key = hash(`${site.vhost}|${site.domain}`);
            site.types = TYPES_BY_RUNTIME[site.runtime];
            sites.push(site);

            const fail = (reason: string) => {
                site.reason = reason;
            };

            if (!ABS_PATH.test(enabledPath) || !ABS_PATH.test(site.vhost) || !site.vhost.startsWith("/etc/nginx/")) {
                fail(`The nginx file ${label} lives outside /etc/nginx, so it is left alone.`);
                continue;
            }
            if (info.roots.length === 0) {
                fail(info.names.length ? "It has no root folder (a redirect or proxy-only site?)." : "It has no server_name or root folder.");
                continue;
            }
            if (info.roots.length > 1) {
                fail(`It serves more than one folder (${info.roots.join(", ")}). Import it by hand.`);
                continue;
            }

            const root = info.roots[0];
            const m = /^\/home\/([^\/]+)\/([^\/]+)(?:\/(.+))?$/.exec(root);
            if (!m) {
                fail(`Its folder ${root} isn't inside /home/<user>/<domain>, where Flux keeps sites.`);
                continue;
            }
            const [, user, folder, web = ""] = m;
            if (!USER.test(user) || RESERVED_USERS.includes(user)) {
                fail(`It runs as "${user}", which Flux can't use as a site user.`);
                continue;
            }
            if (!DOMAIN.test(folder) || !info.names.includes(folder)) {
                fail(`Its folder /home/${user}/${folder} isn't named after one of its domains (${info.names.join(", ") || "none"}).`);
                continue;
            }
            if (web && (!REL_PATH.test(web) || web.split("/").includes(".."))) {
                fail(`Its web directory ${web} has characters Flux doesn't accept.`);
                continue;
            }

            site.domain = folder;
            site.aliases = info.names.filter((n) => n !== folder && DOMAIN.test(n));
            site.user = user;
            site.root = `/home/${user}/${folder}`;
            site.webDirectory = web;
            site.key = hash(`${site.vhost}|${site.domain}`);

            if (fluxDomains.has(folder)) {
                fail("Already in Flux.");
                continue;
            }
            if (seenDomains.has(folder)) {
                fail("Another nginx file on this server uses the same domain.");
                continue;
            }
            seenDomains.add(folder);

            const u = users.get(user);
            if (!u) {
                fail(`The user ${user} doesn't exist on the server.`);
                continue;
            }
            if (u.uid < 1000) {
                fail(`The user ${user} is a system account.`);
                continue;
            }

            if (site.runtime === "php") {
                const v = /php(\d\.\d)-fpm/.exec(info.phpSocket)?.[1] ?? "";
                site.phpVersion = v || phpVersions[phpVersions.length - 1] || "";
                if (!site.phpVersion) {
                    fail("It sends PHP to PHP-FPM, but no PHP-FPM is installed.");
                    continue;
                }
                if (!phpVersions.includes(site.phpVersion)) {
                    site.notes.push(`PHP ${site.phpVersion} isn't installed as PHP-FPM, so the site may already be down.`);
                }
            }

            if (site.runtime === "node" && (site.port < 1024 || site.port > 65535)) {
                fail(`It proxies to port ${site.port}; Flux needs an app port from 1024 to 65535.`);
                continue;
            }

            if (info.ssl) {
                const live = /^\/etc\/letsencrypt\/live\/[^\/]+\//.test(info.cert);
                site.ssl.mode = info.cert ? (live ? "letsencrypt" : "custom") : "none";
                if (!info.cert) site.notes.push("It listens on 443 but has no certificate line; SSL is recorded as off.");
            }

            site.importable = true;
        }

        // ---- inspect the folders ----
        const candidates = sites.filter((s) => s.importable);
        if (candidates.length > 0) {
            const list = candidates
                .map((s) => [s.key, s.user, s.root, ABS_PATH.test(s.ssl.cert) ? s.ssl.cert : ""].join("\t"))
                .join("\n");
            const second = await sshExec(target, shellScript({ LIST_B64: b64(list + "\n") }, INSPECT_SCRIPT), SCAN_TIMEOUT_MS);
            if (second.code !== 0) {
                throw new ImportError(`Reading the site folders failed: ${lastLine(second.stderr, second.stdout)}`, 502);
            }

            const byKey = new Map(records(second.stdout).filter((r) => r.kind === "site").map((r) => [r.name, kvLines(r.body)]));

            for (const site of candidates) {
                const kv = byKey.get(site.key);
                if (!kv) {
                    site.importable = false;
                    site.reason = "The folder couldn't be read.";
                    continue;
                }
                const has = new Set(kv.many.has ?? []);

                if (kv.one.exists !== "1") {
                    site.importable = false;
                    site.reason = `The folder ${site.root} doesn't exist.`;
                    continue;
                }
                if (kv.one.owner !== site.user) {
                    site.importable = false;
                    site.reason = `The folder ${site.root} belongs to ${kv.one.owner || "someone else"}, not ${site.user}.`;
                    continue;
                }

                // Type
                if (site.runtime === "php") {
                    site.type = has.has("wp-config.php") || has.has("wp-load.php") ? "wordpress" : has.has("artisan") ? "laravel" : "php";
                } else if (site.runtime === "node") {
                    let deps: Record<string, unknown> = {};
                    try {
                        const pkg = JSON.parse(unb64(kv.one.pkg ?? "") || "{}");
                        deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
                    } catch {
                        deps = {};
                    }
                    site.type = "@tylix/core" in deps ? "tylix" : "next" in deps ? "nextjs" : "nuxt" in deps ? "nuxt" : "nodejs";
                } else {
                    site.type = "static";
                }

                // Git
                const head = kv.one.head ?? "";
                const remote = (kv.one.remote ?? "").trim();
                if (head) {
                    const b = /^ref:\s*refs\/heads\/(.+)$/.exec(head.trim())?.[1] ?? "";
                    if (b && BRANCH.test(b) && !b.includes("..")) site.branch = b;
                    else site.notes.push("The git checkout isn't on a branch, so deploys stay off until you set one.");

                    if (remote) {
                        const r = parseRemote(remote);
                        site.remote = remote.replace(/\/\/[^@\/]+@/, "//");
                        site.remoteIsSsh = r.ssh;
                        site.gitHost = r.host;
                        site.repository = r.repo;
                        if (!r.host) site.notes.push(`The code comes from ${r.other || "an unknown host"}; Flux deploys from GitHub or GitLab, so deploys stay off.`);
                        else if (!r.repo) site.notes.push("The repository path isn't owner/name, so deploys stay off.");
                        if (/\/\/[^@\/]+:[^@\/]+@/.test(remote)) site.notes.push("The git remote has a password or token in it. Switching it to HTTPS removes that.");
                        if (r.host) site.sourceControlId = sources.find((s) => s.kind === r.host)?.id ?? 0;
                        if (r.host && !site.sourceControlId) {
                            site.notes.push(`No ${r.host === "github" ? "GitHub" : "GitLab"} connection on this team yet. Add one under Source control to deploy from Flux.`);
                        }
                    } else {
                        site.notes.push("The git checkout has no origin remote.");
                    }
                } else if (site.type !== "wordpress") {
                    site.notes.push("No git checkout in the folder, so there is nothing for Flux to deploy.");
                }

                // SSL
                if (site.ssl.mode !== "none") {
                    site.ssl.expiresAt = toIso(kv.one.certend ?? "");
                    if (!site.ssl.expiresAt) site.notes.push("The certificate file couldn't be read.");
                }

                // PHP-FPM pool Flux's own nginx templates point at.
                if (site.runtime === "php") {
                    const sock = `/run/php/php${site.phpVersion}-fpm-${site.user}.sock`;
                    const file = `/etc/php/${site.phpVersion}/fpm/pool.d/${site.user}.conf`;
                    const own = pools.find((p) => p.file === file);
                    const sameName = pools.find((p) => p.file.startsWith(`/etc/php/${site.phpVersion}/`) && p.names.includes(site.user));
                    if (own && own.listen.includes(sock)) site.pool = "exists";
                    else if (!own && !sameName) site.pool = "create";
                    else {
                        site.pool = "conflict";
                        site.notes.push(
                            `PHP-FPM already has a "${site.user}" pool that doesn't listen on ${sock}. Changing SSL from Flux would rewrite nginx to use that socket, so edit the nginx config by hand instead.`,
                        );
                    }
                }
            }

            // Node sites name their service after the user, so the user must be theirs alone.
            const fluxUsers = new Map(flux.map((s) => [s.isolated_user, s]));
            for (const site of candidates.filter((s) => s.importable)) {
                const owner = fluxUsers.get(site.user);
                if (owner && owner.origin !== "import") {
                    site.importable = false;
                    site.reason = `The Flux site ${owner.domain} already uses the user ${site.user}. Deleting that site removes the whole user, so this site can't join it.`;
                    continue;
                }
                const shared =
                    flux.some((s) => s.isolated_user === site.user) ||
                    candidates.some((o) => o !== site && o.importable && o.user === site.user);
                if (site.runtime === "node" && shared) {
                    site.importable = false;
                    site.reason = `Other sites also run as ${site.user}. Flux runs each Node app as the service app-<user>, so it can only manage one per user.`;
                }
                if (shared && site.runtime !== "node") {
                    site.notes.push(`Shares the user ${site.user} with other sites, so per-user plugins (queue, scheduler, rate limit) stay off for it.`);
                }
            }
        }

        // ---- databases ----
        const mysqlMissing = recs.some((r) => r.kind === "mysql-missing");
        const mysqlError = recs.find((r) => r.kind === "mysql-error")?.body.trim() ?? "";
        const databases: ScannedDatabase[] = [];

        const known = new Set(((await ServerDatabase.all()) as { server_id: number; name: string }[])
            .filter((d) => Number(d.server_id) === server.id)
            .map((d) => d.name));

        const dbRec = recs.find((r) => r.kind === "mysql-dbs");
        if (dbRec) {
            const grants = (recs.find((r) => r.kind === "mysql-grants")?.body ?? "")
                .split("\n")
                .map((l) => l.split("\t"))
                .filter((p) => p.length >= 3)
                .map(([user, host, db]) => ({ user, host, db: unescapeMysqlDb(db) }));

            for (const line of dbRec.body.split("\n")) {
                const [name, charset = "", collation = ""] = line.split("\t");
                if (!name || SYSTEM_DATABASES.includes(name)) continue;

                const db: ScannedDatabase = {
                    key: name,
                    name,
                    charset,
                    collation,
                    owner: "",
                    importable: false,
                    reason: "",
                    notes: [],
                };
                databases.push(db);

                const problem = checkDatabaseName(name);
                if (problem) {
                    db.reason = `Flux only manages databases named with lowercase letters, digits and _ (starting with a letter).`;
                    continue;
                }
                if (known.has(name)) {
                    db.reason = "Already in Flux.";
                    continue;
                }

                const owners = grants.filter((g) => g.db === name && !SYSTEM_DB_USERS.includes(g.user));
                const local = owners.filter((g) => g.host === "localhost" && !checkDbUserName(g.user));
                if (local.length > 0) {
                    db.owner = local[0].user;
                    if (local.length > 1) db.notes.push(`Also used by ${local.slice(1).map((g) => g.user).join(", ")}; only ${db.owner} is linked in Flux.`);
                }
                const remote = owners.filter((g) => g.host !== "localhost");
                if (remote.length > 0) {
                    db.notes.push(`${remote.map((g) => `${g.user}@${g.host}`).join(", ")} can also reach it; Flux only manages users @localhost.`);
                }
                if (!db.owner) db.notes.push("No local user Flux can manage has access to it.");
                db.importable = true;
            }
        }

        // ---- workers ----
        const workers: ScannedWorker[] = [];
        for (const r of recs.filter((x) => x.kind === "supervisor")) {
            const parsed = parseSupervisor(r.body);
            const file = r.name;
            const base = file.split("/").pop() ?? file;

            for (const p of parsed.programs) {
                const v = p.values;
                const user = v.user || "root";
                const w: ScannedWorker = {
                    key: hash(`${file}|${p.name}`),
                    name: p.name,
                    file,
                    program: p.name,
                    command: (v.command ?? "").replace(/%%/g, "%"),
                    directory: v.directory || (user === "root" ? "/root" : `/home/${user}`),
                    user,
                    processes: Number(v.numprocs || 1),
                    importable: false,
                    reason: "",
                };
                workers.push(w);

                if (/^tylix-worker-\d+$/.test(p.name)) {
                    w.reason = "Already in Flux.";
                    continue;
                }
                if (parsed.programs.length > 1) {
                    w.reason = `${base} holds more than one program. Import those by hand.`;
                    continue;
                }
                if (parsed.continued) {
                    w.reason = `${base} has settings spread over several lines, which Flux can't copy safely.`;
                    continue;
                }
                if (!ABS_PATH.test(file) || !file.startsWith("/etc/supervisor/conf.d/")) {
                    w.reason = "Its config file has an unusual path.";
                    continue;
                }
                if (!w.command || w.command.length > 500 || hasControl(w.command)) {
                    w.reason = "Its command is empty or longer than 500 characters.";
                    continue;
                }
                if (/%\(/.test(w.command)) {
                    w.reason = "Its command uses Supervisor variables such as %(program_name)s.";
                    continue;
                }
                if (!WORKER_DIR.test(w.directory) || w.directory.includes("..")) {
                    w.reason = `Its directory ${w.directory} has characters Flux doesn't accept.`;
                    continue;
                }
                if (!UNIX_USER.test(user)) {
                    w.reason = `It runs as "${user}", which isn't a valid user name.`;
                    continue;
                }
                if (!Number.isInteger(w.processes) || w.processes < 1 || w.processes > 20) {
                    w.reason = "It runs more than 20 processes.";
                    continue;
                }
                w.importable = true;
            }
        }

        // ---- cron ----
        const cron: ScannedCron[] = [];
        for (const r of recs.filter((x) => x.kind === "cron")) {
            const user = r.name;
            for (const line of r.body.split("\n")) {
                const parsed = parseCronLine(line);
                if (!parsed) continue;

                const c: ScannedCron = {
                    key: hash(`${user}\n${line}`),
                    user,
                    schedule: parsed.schedule,
                    command: parsed.command.replace(/\\%/g, "%"),
                    line,
                    importable: false,
                    reason: "",
                };
                cron.push(c);

                if (line.includes("# tylix-scheduler")) {
                    c.reason = "Added by a site's Task scheduler plugin; it stays with the plugin.";
                    continue;
                }
                if (!UNIX_USER.test(user)) {
                    c.reason = `It belongs to "${user}", which isn't a valid user name.`;
                    continue;
                }
                if (!CronFiles.checkSchedule(parsed.schedule)) {
                    c.reason = "Its schedule uses a form Flux doesn't support (names like mon or jan, or more fields).";
                    continue;
                }
                if (!c.command || c.command.length > 500 || hasControl(c.command)) {
                    c.reason = "Its command is empty or longer than 500 characters.";
                    continue;
                }
                if (/(^|[^\\])%/.test(parsed.command)) {
                    c.reason = "Its command has an unescaped %, which cron turns into input. Import it by hand.";
                    continue;
                }
                c.importable = true;
            }
        }

        return {
            sites,
            databases,
            workers,
            cron,
            phpVersions,
            mysql: {
                available: Boolean(dbRec),
                error: mysqlMissing ? "MySQL isn't installed." : mysqlError ? `MySQL couldn't be read: ${mysqlError.split("\n").pop()}` : "",
            },
            scannedAt: new Date().toISOString(),
        };
    },

    // ---- import -------------------------------------------------------------

    /**
     * Re-scans, checks every pick against that fresh scan (the browser only
     * sends keys and choices, never paths), then adopts each item in turn.
     * One item failing never stops the others; the report says what happened.
     */
    async run(server: ImportServer, picks: ImportPicks, actor: { userId: number; teamId: number }): Promise<ItemReport[]> {
        const scan = await ServerImport.scan(server);
        const target = serverTarget(server as never);
        const report: ItemReport[] = [];
        const sources = await teamSourceControls(actor.teamId);

        const siteByKey = new Map(scan.sites.map((s) => [s.key, s]));
        const pickedSites = picks.sites
            .map((p) => ({ pick: p, site: siteByKey.get(String(p.key)) }))
            .filter((x): x is { pick: SitePick; site: ScannedSite } => Boolean(x.site));

        for (const p of picks.sites) {
            const s = siteByKey.get(String(p.key));
            if (!s || !s.importable) {
                report.push({ kind: "site", key: String(p.key), name: s?.domain ?? String(p.key), ok: false, error: s ? s.reason : "Not found in the latest scan. Scan again.", notes: [], id: 0 });
            }
        }

        // .env and wp-config.php of every importable site: env for the sites
        // themselves, DB credentials to fill in database user passwords.
        const secrets = new Map<string, { env: string; wp: string }>();
        const readable = scan.sites.filter((s) => s.importable);
        if (readable.length > 0) {
            const list = readable.map((s) => `${s.key}\t${s.root}`).join("\n");
            const r = await sshExec(target, shellScript({ LIST_B64: b64(list + "\n") }, SECRETS_SCRIPT), SCAN_TIMEOUT_MS);
            if (r.code === 0) {
                for (const rec of records(r.stdout)) {
                    const entry = secrets.get(rec.name) ?? { env: "", wp: "" };
                    if (rec.kind === "env") entry.env = rec.body;
                    if (rec.kind === "wp") entry.wp = rec.body;
                    secrets.set(rec.name, entry);
                }
            }
        }

        const passwords = new Map<string, string>();
        for (const [, s] of secrets) {
            const env = parseEnv(s.env);
            if (env.DB_USERNAME && env.DB_PASSWORD) passwords.set(env.DB_USERNAME, env.DB_PASSWORD);
            const wp = parseWpConfig(s.wp);
            if (wp.DB_USER && wp.DB_PASSWORD) passwords.set(wp.DB_USER, wp.DB_PASSWORD);
        }

        // ---- sites ----
        for (const { pick, site } of pickedSites) {
            if (!site.importable) continue;
            const item: ItemReport = { kind: "site", key: site.key, name: site.domain, ok: false, error: "", notes: [...site.notes], id: 0 };
            report.push(item);

            const type = pick.type && site.types.includes(pick.type) ? pick.type : site.type;
            const info = getType(type);
            if (!info) {
                item.error = "Unknown site type.";
                continue;
            }

            let phpVersion = site.phpVersion;
            if (site.runtime === "php" && pick.php_version && scan.phpVersions.includes(pick.php_version)) phpVersion = pick.php_version;

            let sourceControlId = Number(pick.source_control_id ?? site.sourceControlId) || 0;
            const source = sources.find((s) => s.id === sourceControlId);
            if (sourceControlId && (!source || source.kind !== site.gitHost)) {
                item.error = "That source control connection doesn't belong to this team or is for another host.";
                continue;
            }
            if (!site.repository || !site.branch) sourceControlId = 0;
            if (type === "wordpress") sourceControlId = 0;

            // Re-check sharing against what is in Flux right now (earlier picks included).
            const now = await fluxSitesOn(server.id);
            if (now.some((s) => s.domain === site.domain)) {
                item.error = "Already in Flux.";
                continue;
            }
            const userOwner = now.find((s) => s.isolated_user === site.user);
            if (userOwner && userOwner.origin !== "import") {
                item.error = `The Flux site ${userOwner.domain} already uses the user ${site.user}.`;
                continue;
            }
            if (userOwner && (site.runtime === "node" || needsOwnUnit(userOwner.type))) {
                item.error = `The Node site ${userOwner.domain} already runs as ${site.user}, and Flux runs one Node app per user.`;
                continue;
            }

            const httpsUrl =
                sourceControlId && pick.https_remote !== false && site.remoteIsSsh
                    ? `https://${site.gitHost === "gitlab" ? "gitlab.com" : "github.com"}/${site.repository}.git`
                    : "";

            const vars: Record<string, string> = {
                DOMAIN: site.domain,
                SITE_USER: site.user,
                SITE_ROOT: site.root,
                SRC: site.vhost,
                LINK: site.enabledPath,
                PHP_VERSION: phpVersion,
                POOL_B64:
                    site.runtime === "php" && site.pool === "create"
                        ? b64(fpmPool({ isolated_user: site.user, php_version: phpVersion }))
                        : "",
                REMOTE_URL: httpsUrl,
            };

            const r = await sshExec(target, shellScript(vars, ADOPT_SITE_SCRIPT), STEP_TIMEOUT_MS);
            const output = `${r.stdout}\n${r.stderr}`.trim();
            if (r.code !== 0) {
                item.error = r.code === 255 ? "Couldn't reach the server over SSH." : lastLine(r.stderr, r.stdout);
                continue;
            }
            item.notes.push(...warnings(r.stdout));

            const envText = secrets.get(site.key)?.env ?? "";
            const keepsEnv = info.runtime === "php" ? type !== "wordpress" : info.runtime === "node";
            const env = keepsEnv && envText.trim() !== "" ? CryptoService.encrypt(envText) : "";
            if (env) item.notes.push("Its .env is now in Flux; every deploy writes it back, so edit it there from now on.");

            const stamp = new Date().toISOString();
            const log = [
                `Imported from the server on ${stamp}. Nothing was reinstalled.`,
                `Folder: ${site.root}${site.webDirectory ? ` (web root ${site.webDirectory})` : ""}`,
                output
                    .split("\n")
                    .filter((l) => l.trim() && !l.startsWith("WARN: "))
                    .join("\n"),
                ...item.notes.map((n) => `Note: ${n}`),
            ]
                .filter(Boolean)
                .join("\n");

            const row = (await Site.create({
                user_id: actor.userId,
                team_id: actor.teamId,
                server_id: server.id,
                source_control_id: sourceControlId,
                type,
                domain: site.domain,
                aliases: JSON.stringify(site.aliases),
                isolated_user: site.user,
                php_version: site.runtime === "php" ? phpVersion : "",
                port: site.runtime === "node" ? site.port : 0,
                repository: sourceControlId ? site.repository : "",
                branch: sourceControlId ? site.branch : "",
                web_directory: site.webDirectory,
                app_directory: "",
                backend_directory: "",
                build_command: info.defaults.build_command,
                start_command: info.defaults.start_command,
                install_deps: sourceControlId ? 1 : 0,
                status: "ready",
                step: "ready",
                error: "",
                log,
                deploy_script: "",
                env_content: env,
                deploy_status: "",
                deploy_log: "",
                deployed_at: "",
                ssl_mode: site.ssl.mode,
                ssl_status: site.ssl.mode === "none" ? "idle" : "active",
                ssl_email: "",
                ssl_error: "",
                ssl_log: "",
                ssl_expires_at: site.ssl.expiresAt,
                origin: "import",
            })) as { id: number } | null;

            if (!row) {
                item.error = "The server side was done, but the site couldn't be saved in Flux. Scan again and retry.";
                continue;
            }
            item.ok = true;
            item.id = row.id;
        }

        // ---- databases ----
        const dbByKey = new Map(scan.databases.map((d) => [d.key, d]));
        const dbUsers = ((await DbUser.all()) as { id: number; server_id: number; name: string }[]).filter((u) => Number(u.server_id) === server.id);

        for (const key of picks.databases) {
            const db = dbByKey.get(String(key));
            const item: ItemReport = { kind: "database", key: String(key), name: db?.name ?? String(key), ok: false, error: "", notes: [...(db?.notes ?? [])], id: 0 };
            report.push(item);
            if (!db || !db.importable) {
                item.error = db ? db.reason : "Not found in the latest scan. Scan again.";
                continue;
            }

            let ownerId = 0;
            if (db.owner) {
                let owner = dbUsers.find((u) => u.name === db.owner);
                if (!owner) {
                    const password = passwords.get(db.owner) ?? "";
                    owner = (await DbUser.create({
                        user_id: actor.userId,
                        team_id: actor.teamId,
                        server_id: server.id,
                        name: db.owner,
                        host: "localhost",
                        password: password ? CryptoService.encrypt(password) : "",
                    })) as { id: number; server_id: number; name: string };
                    if (owner) dbUsers.push(owner);
                    item.notes.push(
                        password
                            ? `Added the user ${db.owner}; its password was read from a site's config.`
                            : `Added the user ${db.owner}. Its password isn't known to Flux: reset it on the Databases page if you need it (update the app's config too).`,
                    );
                }
                ownerId = owner ? Number(owner.id) : 0;
            }

            const row = (await ServerDatabase.create({
                user_id: actor.userId,
                team_id: actor.teamId,
                server_id: server.id,
                db_user_id: ownerId,
                name: db.name,
                charset: db.charset,
                collation: db.collation,
            })) as { id: number } | null;

            item.ok = Boolean(row);
            item.id = row ? row.id : 0;
            if (!row) item.error = "Couldn't save the database record.";
        }

        // ---- workers ----
        const workerByKey = new Map(scan.workers.map((w) => [w.key, w]));
        for (const key of picks.workers) {
            const w = workerByKey.get(String(key));
            const item: ItemReport = { kind: "worker", key: String(key), name: w?.name ?? String(key), ok: false, error: "", notes: [], id: 0 };
            report.push(item);
            if (!w || !w.importable) {
                item.error = w ? w.reason : "Not found in the latest scan. Scan again.";
                continue;
            }

            const row = (await ServerWorker.create({
                user_id: actor.userId,
                team_id: actor.teamId,
                server_id: server.id,
                name: w.name,
                command: w.command,
                directory: w.directory,
                ssh_user: w.user,
                processes: w.processes,
            })) as { id: number } | null;
            if (!row) {
                item.error = "Couldn't save the worker record.";
                continue;
            }

            // The Flux program starts first; only then is the old one stopped and its file removed.
            const old = WorkerFiles.sq(w.file);
            const script = [
                WorkerFiles.installScript(row.id, { command: w.command, directory: w.directory, user: w.user, processes: w.processes }),
                `supervisorctl stop ${WorkerFiles.sq(w.program + ":*")} >/dev/null 2>&1 || true`,
                `mkdir -p /etc/supervisor/tylix-backups`,
                `mv ${old} /etc/supervisor/tylix-backups/import-$(basename ${old})-$(date +%Y%m%d%H%M%S)`,
                "supervisorctl reread >/dev/null",
                "supervisorctl update >/dev/null",
            ].join("\n");

            const r = await sshExec(target, asRootSh(server.ssh_user, script), STEP_TIMEOUT_MS);
            if (r.code !== 0) {
                // Undo: drop the Flux program and start the old one again if its file is still there.
                const undo = [
                    WorkerFiles.removeScript(row.id),
                    `if [ -f ${old} ]; then supervisorctl start ${WorkerFiles.sq(w.program + ":*")} >/dev/null 2>&1 || true; fi`,
                ].join("\n");
                await sshExec(target, asRootSh(server.ssh_user, undo), STEP_TIMEOUT_MS);
                await ServerWorker.delete(row.id);
                item.error = r.code === 255 ? "Couldn't reach the server over SSH." : lastLine(r.stderr, r.stdout);
                continue;
            }
            item.ok = true;
            item.id = row.id;
            item.notes.push(`Now runs as ${WorkerFiles.program(row.id)}; the old program ${w.program} was stopped and its file saved in /etc/supervisor/tylix-backups.`);
        }

        // ---- cron ----
        const cronByKey = new Map(scan.cron.map((c) => [c.key, c]));
        for (const key of picks.cron) {
            const c = cronByKey.get(String(key));
            const item: ItemReport = { kind: "cron", key: String(key), name: c ? `${c.schedule} ${c.command}`.slice(0, 120) : String(key), ok: false, error: "", notes: [], id: 0 };
            report.push(item);
            if (!c || !c.importable) {
                item.error = c ? c.reason : "Not found in the latest scan. Scan again.";
                continue;
            }

            const row = (await ServerCronJob.create({
                user_id: actor.userId,
                team_id: actor.teamId,
                server_id: server.id,
                name: cronName(c.command),
                command: c.command,
                ssh_user: c.user,
                schedule: c.schedule,
            })) as { id: number } | null;
            if (!row) {
                item.error = "Couldn't save the cron job record.";
                continue;
            }

            // The cron.d file is written first, then the exact line leaves the crontab.
            const script = [
                CronFiles.installScript(row.id, { command: c.command, user: c.user, schedule: c.schedule }),
                `LINE="$(printf %s ${CronFiles.sq(b64(c.line))} | base64 -d)"`,
                `CUR="$(crontab -l -u ${CronFiles.sq(c.user)} 2>/dev/null || true)"`,
                `if ! printf '%s\\n' "$CUR" | grep -qxF -- "$LINE"; then echo "The line changed in the crontab since the scan. Scan again." >&2; exit 7; fi`,
                `printf '%s\\n' "$CUR" | grep -vxF -- "$LINE" | crontab -u ${CronFiles.sq(c.user)} -`,
            ].join("\n");

            const r = await sshExec(target, asRootSh(server.ssh_user, script), STEP_TIMEOUT_MS);
            if (r.code !== 0) {
                await sshExec(target, asRootSh(server.ssh_user, CronFiles.removeScript(row.id)), STEP_TIMEOUT_MS);
                await ServerCronJob.delete(row.id);
                item.error = r.code === 255 ? "Couldn't reach the server over SSH." : lastLine(r.stderr, r.stdout);
                continue;
            }
            item.ok = true;
            item.id = row.id;
            item.notes.push(`Moved from ${c.user}'s crontab to /etc/cron.d/${CronFiles.jobName(row.id)}.`);
        }

        return report;
    },
};

/** Flux-created sites of these types run the service app-<user>. */
function needsOwnUnit(type: string): boolean {
    const runtime = getType(type)?.runtime;
    return runtime !== undefined && runtime !== "php" && runtime !== "static";
}

/** A readable name for an imported cron job, from its command. */
function cronName(command: string): string {
    const artisan = /artisan\s+([a-z:_-]+)/.exec(command);
    if (artisan) return `artisan ${artisan[1]}`.slice(0, 100);
    const words = command.replace(/^cd\s+\S+\s*&&\s*/, "").split(/\s+/).slice(0, 4).join(" ");
    return (words || "Imported job").slice(0, 100);
}
