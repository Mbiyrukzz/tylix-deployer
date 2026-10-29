/**
 * Reads a site's logs over SSH, for the Logs page. Nothing is stored: every
 * request tails the log on the server, groups the lines into entries (a stack
 * trace stays attached to its error), redacts obvious secrets and returns the
 * newest entries first.
 *
 * Sources (only the ones that apply to the site's type are offered):
 *   app       journalctl for the app-<user> systemd unit (node, mern, python, java, go, ruby, dotnet, rust)
 *   laravel   storage/logs/laravel*.log (newest file) in the app folder
 *   nginx     /var/log/nginx/<domain>-error.log
 *   phpfpm    the shared php<ver>-fpm.log, only lines from this site's pool
 *   http5xx   requests in /var/log/nginx/<domain>-access.log that answered 5xx
 *
 * The domain, user and folders come from the site row (validated when the site
 * was created) and reach the shell only through shellScript variables. The
 * source and line count are whitelisted / clamped by the controller.
 *
 * The server must belong to the same team as the site.
 */

import { createHash } from "node:crypto";
import { Server } from "../models/Server.js";
import { sshExec } from "./Ssh.js";
import { shellScript, serverTarget } from "./Shell.js";
import { getType, isPhp, isAppRuntime } from "./SiteTypes.js";
import { teamIdOfRow } from "./TeamScope.js";

export type LogSourceId = "app" | "laravel" | "nginx" | "phpfpm" | "http5xx";

export interface LogSite {
    id: number;
    user_id: number;
    team_id?: number | null;
    server_id: number;
    type: string;
    domain: string;
    isolated_user: string;
    php_version: string;
    app_directory: string;
    [key: string]: unknown;
}

export interface LogEntry {
    id: string;
    time: string;
    level: string;
    error: boolean;
    message: string;
    detail: string;
    line_count: number;
}

interface ServerRow {
    user_id: number;
    team_id?: number | null;
    [key: string]: unknown;
}

export const MIN_LINES = 100;
export const MAX_LINES = 3000;
export const DEFAULT_LINES = 1000;

const MAX_ENTRIES = 200;
const MAX_DETAIL = 20_000;
const MAX_MESSAGE = 300;
const TIMEOUT_MS = 30_000;
const MISSING = "__TYLIX_NO_LOG__";

export function sourcesFor(site: Pick<LogSite, "type">): { id: LogSourceId; label: string }[] {
    const runtime = getType(site.type)?.runtime ?? "static";
    const list: { id: LogSourceId; label: string }[] = [];

    if (isAppRuntime(runtime)) list.push({ id: "app", label: "App" });
    if (site.type === "laravel") list.push({ id: "laravel", label: "Laravel" });
    list.push({ id: "nginx", label: "nginx errors" });
    if (isPhp(site.type)) list.push({ id: "phpfpm", label: "PHP-FPM" });
    list.push({ id: "http5xx", label: "5xx requests" });

    return list;
}

// ---- what runs on the server (no ${...} in here: these are plain bash) ----

const SCRIPTS: Record<LogSourceId, string> = {
    app: `
UNIT="app-$SITE_USER"
$SUDO journalctl -u "$UNIT" -n "$LINES" --no-pager -o short-iso 2>&1 || true`,

    laravel: `
WORK="$SITE_ROOT"
if [ -n "$APP_DIR" ]; then WORK="$SITE_ROOT/$APP_DIR"; fi
F="$(ls -t "$WORK"/storage/logs/laravel*.log 2>/dev/null | head -n 1 || true)"
if [ -n "$F" ] && [ -f "$F" ]; then
  $SUDO tail -n "$LINES" "$F"
else
  echo "${MISSING}"
fi`,

    nginx: `
F="/var/log/nginx/$DOMAIN-error.log"
if [ -f "$F" ]; then
  $SUDO tail -n "$LINES" "$F"
else
  echo "${MISSING}"
fi`,

    phpfpm: `
F="/var/log/php$PHP_VERSION-fpm.log"
if [ -f "$F" ]; then
  $SUDO tail -n 5000 "$F" | grep -F "[pool $SITE_USER]" | tail -n "$LINES" || true
else
  echo "${MISSING}"
fi`,

    http5xx: `
F="/var/log/nginx/$DOMAIN-access.log"
if [ -f "$F" ]; then
  $SUDO tail -n "$LINES" "$F" | awk '$9 ~ /^5[0-9][0-9]$/' || true
else
  echo "${MISSING}"
fi`,
};

// ---- parsing ----

interface Head {
    time: string;
    level: string; // "" means: work it out from the text
    message: string;
    more?: string; // a continuation line: append this to the previous entry
}

interface Raw {
    head: Head;
    lines: string[];
}

const NGINX = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] (.*)$/;
const LARAVEL = /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}[^\]]*)\] [\w.-]+\.(\w+): (.*)$/;
const FPM = /^\[(\d{2}-\w{3}-\d{4} \d{2}:\d{2}:\d{2})\] (\w+): (.*)$/;
const JOURNAL = /^(\d{4}-\d{2}-\d{2}T\S+) \S+ [^\s:]+: ?(.*)$/;
const ACCESS = /^(\S+) \S+ \S+ \[([^\]]+)\] "([^"]*)" (\d{3}) /;

const HEADERS: Record<LogSourceId, (line: string) => Head | null> = {
    nginx(line) {
        const m = NGINX.exec(line);
        return m ? { time: m[1], level: m[2], message: m[3] } : null;
    },
    laravel(line) {
        const m = LARAVEL.exec(line);
        return m ? { time: m[1], level: m[2], message: m[3] } : null;
    },
    phpfpm(line) {
        const m = FPM.exec(line);
        return m ? { time: m[1], level: m[2], message: m[3] } : null;
    },
    app(line) {
        const m = JOURNAL.exec(line);
        if (!m) return null;
        // Indented lines are the rest of a stack trace the app printed.
        if (/^\s+/.test(m[2])) return { time: m[1], level: "", message: "", more: m[2] };
        return { time: m[1], level: "", message: m[2] };
    },
    http5xx(line) {
        const m = ACCESS.exec(line);
        return m ? { time: m[2], level: "error", message: `${m[4]} ${m[3]} (from ${m[1]})` } : null;
    },
};

const ERROR_LEVELS = new Set(["error", "err", "crit", "critical", "alert", "emerg", "emergency", "fatal"]);

/** Journal lines carry no level, so this is a guess from the text. */
const LOOKS_LIKE_ERROR =
    /\b(error|exception|fatal|unhandled|panic|traceback|failed|segfault|ECONNREFUSED|EADDRINUSE|ENOENT|killed)\b/i;

function redact(text: string): string {
    return text
        .replace(/(https?:\/\/)[^\s:@\/]+:[^\s@\/]+@/g, "$1***@")
        .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "Bearer ***")
        .replace(/\b(password|passwd|secret|token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',&)]+/gi, "$1$2***")
        .replace(/base64:[A-Za-z0-9+\/=]{20,}/g, "base64:***");
}

function group(text: string, header: (line: string) => Head | null): Raw[] {
    const out: Raw[] = [];

    for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
        if (line.trim() === "") continue;

        const head = header(line);

        if (head && head.more === undefined) {
            out.push({ head, lines: [line] });
        } else if (out.length > 0) {
            // A stack trace line. Lines before the first header are the tail
            // of an entry the window cut in half, so they are dropped.
            out[out.length - 1].lines.push(head?.more ?? line);
        }
    }

    return out;
}

function toEntries(source: LogSourceId, raws: Raw[]): LogEntry[] {
    const seen = new Map<string, number>();

    const entries = raws.map((r): LogEntry => {
        const detail = redact(r.lines.join("\n")).slice(0, MAX_DETAIL);
        const level = r.head.level !== "" ? r.head.level.toLowerCase() : LOOKS_LIKE_ERROR.test(detail) ? "error" : "info";

        const base = createHash("sha1").update(`${source}\n${r.lines[0]}`).digest("hex").slice(0, 10);
        const n = (seen.get(base) ?? 0) + 1;
        seen.set(base, n);

        return {
            id: n === 1 ? base : `${base}-${n}`,
            time: r.head.time,
            level,
            error: ERROR_LEVELS.has(level),
            message: redact(r.head.message || r.lines[0]).split("\n")[0].slice(0, MAX_MESSAGE),
            detail,
            line_count: r.lines.length,
        };
    });

    return entries.reverse(); // newest first
}

function lastLine(stderr: string, stdout: string): string {
    const text = stderr.trim() || stdout.trim();
    const lines = text.split("\n").filter((l) => l.trim() !== "" && !l.startsWith("Warning: Permanently added"));
    return (lines[lines.length - 1] ?? "Command failed.").slice(0, 300);
}

async function targetFor(site: LogSite) {
    const server = (await Server.find(site.server_id)) as ServerRow | null;
    if (!server || (await teamIdOfRow(server)) !== (await teamIdOfRow(site))) {
        throw new Error("The server no longer exists.");
    }
    return serverTarget(server as never);
}

export const SiteLogs = {
    async read(
        site: LogSite,
        source: LogSourceId,
        lines: number,
        errorsOnly: boolean,
    ): Promise<{ entries: LogEntry[]; missing: boolean; scanned: number }> {
        const target = await targetFor(site);

        const script = shellScript(
            {
                DOMAIN: site.domain,
                SITE_USER: site.isolated_user,
                SITE_ROOT: `/home/${site.isolated_user}/${site.domain}`,
                APP_DIR: String(site.app_directory ?? ""),
                PHP_VERSION: String(site.php_version ?? ""),
                LINES: String(lines),
            },
            SCRIPTS[source],
        );

        const result = await sshExec(target, script, TIMEOUT_MS);
        if (result.code !== 0) throw new Error(lastLine(result.stderr, result.stdout));

        const out = String(result.stdout ?? "");
        if (out.includes(MISSING)) return { entries: [], missing: true, scanned: 0 };

        const all = toEntries(source, group(out, HEADERS[source]));
        const entries = (errorsOnly ? all.filter((e) => e.error) : all).slice(0, MAX_ENTRIES);

        return { entries, missing: false, scanned: out.split("\n").length };
    },
};