/**
 * Database backups per server, MySQL only (same as DatabaseManager).
 * Team-scoped: a server on another team answers 404. Any member can list
 * backups and storage connections; everything else (creating and deleting
 * backups, running them, logs, downloading files, managing Dropbox
 * connections) needs the admin role.
 *
 * The schedule lives ON the server, not in the deployer, so backups keep
 * running when the deployer is down or restarting:
 *
 *   /usr/local/bin/tylix-backup-<id>      the backup script (root, 700)
 *   /etc/cron.d/tylix-backup-<id>         the schedule
 *   /etc/tylix/backup-<id>.env            Dropbox credentials (root, 600), only when used
 *   /var/backups/tylix/backup-<id>/       <db>-YYYYMMDD-HHMMSS.sql.gz, newest N kept per database
 *   /var/log/tylix-backup-<id>.log        output of every run
 *
 * Each run dumps every selected database to its own file, keeps the newest
 * `retention` files per database, and (when a Dropbox storage is chosen)
 * uploads each file and prunes Dropbox to the same retention.
 *
 *   GET    /api/backup-storages                        any member
 *   POST   /api/backup-storages                        admin: connect Dropbox
 *   DELETE /api/backup-storages/:sid                   admin
 *   GET    /api/servers/:id/backups                    any member
 *   POST   /api/servers/:id/backups                    admin
 *   DELETE /api/servers/:id/backups/:bid               admin: removes the schedule; files stay on the server
 *   POST   /api/servers/:id/backups/:bid/run           admin: starts a run in the background
 *   GET    /api/servers/:id/backups/:bid/log           admin
 *   GET    /api/servers/:id/backups/:bid/files         admin
 *   GET    /api/servers/:id/backups/:bid/files/download?name=   admin
 *   DELETE /api/servers/:id/backups/:bid/files?name=   admin
 */

import type { Router } from "@tylix/core";
import { Server } from "../models/Server.js";
import { ServerDatabase } from "../models/ServerDatabase.js";
import { ServerBackup } from "../models/ServerBackup.js";
import { BackupStorage } from "../models/BackupStorage.js";
import { CryptoService } from "../services/CryptoService.js";
import { sshExec, type SshTarget } from "../services/Ssh.js";
import { requireTeam, requireRole, teamIdOfRow } from "../services/TeamScope.js";

type Handler = Parameters<Router["post"]>[1];
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

interface ServerRow {
    id: number; user_id: number; team_id: number | null; name: string; host: string; port: number; ssh_user: string; ssh_key: string;
    [key: string]: unknown;
}
interface BackupRow {
    id: number; user_id: number; server_id: number; name: string; databases: string;
    storage_id: number; schedule: string; retention: number; created_at: string;
    [key: string]: unknown;
}
interface StorageRow {
    id: number; user_id: number; team_id: number | null; name: string; provider: string; app_key: string;
    app_secret: string; refresh_token: string; created_at: string;
    [key: string]: unknown;
}
interface DbRow {
    id: number; user_id: number; server_id: number; name: string;
    [key: string]: unknown;
}

const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_SECRET = /^[A-Za-z0-9_-]{8,256}$/;
const FILE_NAME = /^[a-z][a-z0-9_]{0,63}-\d{8}-\d{6}\.sql\.gz$/;
const PRESETS = ["@hourly", "@daily", "@weekly", "@monthly", "@yearly"];
const FIELD = /^[0-9*\/,\-]+$/;
const FIELD_MAX = [59, 23, 31, 12, 7];
const MAX_DOWNLOAD = 50 * 1024 * 1024;

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const ROOT_DIR = "/var/backups/tylix";
const ETC_DIR = "/etc/tylix";
const dirOf = (id: number) => `${ROOT_DIR}/backup-${id}`;
const scriptOf = (id: number) => `/usr/local/bin/tylix-backup-${id}`;
const envOf = (id: number) => `${ETC_DIR}/backup-${id}.env`;
const cronOf = (id: number) => `/etc/cron.d/tylix-backup-${id}`;
const logOf = (id: number) => `/var/log/tylix-backup-${id}.log`;

function targetFor(server: ServerRow): SshTarget {
    return {
        host: server.host,
        port: Number(server.port),
        user: server.ssh_user,
        privateKey: CryptoService.decrypt(server.ssh_key),
    };
}

/** Everything here lives under /etc and /var, so scripts run as root (via sudo when we aren't). */
function asRoot(connectUser: string, script: string): string {
    return `${connectUser === "root" ? "" : "sudo -n "}sh -c ${sq(script)}`;
}

function qs(req: Req, key: string): string {
    const q = (req as unknown as { query?: Record<string, unknown> }).query ?? {};
    return typeof q[key] === "string" ? (q[key] as string) : "";
}

/** Loads a server and answers 404 itself if it is missing or not on the caller's team. */
async function ownedServer(req: Req, res: Res): Promise<ServerRow | null> {
    const teamId = requireTeam(req as any, res as any);
    if (!teamId) return null;

    const s = (await Server.find(req.params.id)) as ServerRow | null;
    if (!s || Number(s.team_id) !== teamId) {
        res.status(404);
        res.json({ error: "Server not found." });
        return null;
    }
    return s;
}

/** A backup belongs to the team of its server, so checking the server is enough. */
async function ownedBackup(req: Req, res: Res, server: ServerRow): Promise<BackupRow | null> {
    const b = (await ServerBackup.find(req.params.bid)) as BackupRow | null;
    if (!b || b.server_id !== server.id) {
        res.status(404);
        res.json({ error: "Backup not found." });
        return null;
    }
    return b;
}

/** Storage rows are team-scoped; teamIdOfRow also covers rows created before team_id existed. */
async function storageOnTeam(s: StorageRow | null, teamId: number): Promise<boolean> {
    return Boolean(s) && (await teamIdOfRow(s as StorageRow)) === teamId;
}

function namesOf(row: BackupRow): string[] {
    try {
        const list = JSON.parse(row.databases);
        return Array.isArray(list) ? list.map(String) : [];
    } catch {
        return [];
    }
}

/** Returns the cleaned schedule, or null when it isn't a valid 5-field schedule or @preset. */
function checkSchedule(raw: string): string | null {
    if (PRESETS.includes(raw)) return raw;

    const parts = raw.split(/\s+/);
    if (parts.length !== 5) return null;

    for (let i = 0; i < 5; i++) {
        const part = parts[i];
        if (!FIELD.test(part)) return null;
        if (/\/0+(,|$)/.test(part)) return null;
        for (const n of part.match(/\d+/g) ?? []) {
            if (Number(n) > FIELD_MAX[i]) return null;
        }
    }
    return parts.join(" ");
}

/** Replaces __KEY__ markers. A function replacer, so "$" in values is never treated as a pattern. */
function fill(text: string, values: Record<string, string>): string {
    return text.replace(/__([A-Z_]+)__/g, (m, key: string) => (key in values ? values[key] : m));
}

// ---- the script that runs on the server -------------------------------------
// Written with String.raw and no "${" anywhere, so bash "$VAR" and "$(...)" pass through untouched.

const SCRIPT_HEAD = String.raw`#!/bin/bash
# Generated by tylix-deployer. Recreate the backup in the deployer to change it.
set -uo pipefail
umask 077

DIR='__DIR__'
KEEP=__KEEP__
STAMP=$(date +%Y%m%d-%H%M%S)
FAILED=0

log() { echo "[$(date '+%F %T')] $*"; }

exec 9>/var/lock/tylix-backup-__ID__.lock
flock -n 9 || { log "Another run is still in progress; skipping."; exit 0; }

mkdir -p "$DIR"
`;

const SCRIPT_DROPBOX_SETUP = String.raw`
. '__ENV__'
DBX=1

dbx_token() {
  printf 'user = "%s:%s"\ndata = "grant_type=refresh_token&refresh_token=%s"\n' "$DROPBOX_APP_KEY" "$DROPBOX_APP_SECRET" "$DROPBOX_REFRESH_TOKEN" |
    curl -sS --max-time 30 --config - https://api.dropboxapi.com/oauth2/token |
    sed -n 's/.*"access_token": *"\([^"]*\)".*/\1/p'
}

dbx_upload() {
  local size resp
  size=$(stat -c %s "$1")
  if [ "$size" -gt 157286400 ]; then
    log "  Dropbox: file is over 150 MB, upload skipped"
    return 1
  fi
  resp=$(curl -sS --max-time 900 -w '\n%{http_code}' -X POST https://content.dropboxapi.com/2/files/upload \
    -H "Authorization: Bearer $TOKEN" \
    -H "Dropbox-API-Arg: {\"path\":\"$2\",\"mode\":\"overwrite\",\"mute\":true}" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$1") || { log "  Dropbox: upload failed (network)"; return 1; }
  if [ "$(echo "$resp" | tail -n 1)" != "200" ]; then
    log "  Dropbox: upload failed: $(echo "$resp" | head -n 1 | cut -c1-200)"
    return 1
  fi
}

dbx_prune() {
  curl -sS --max-time 60 -X POST https://api.dropboxapi.com/2/files/list_folder \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data "{\"path\":\"__DDIR__\"}" |
    grep -o '"name": *"[^"]*"' | sed 's/^"name": *"//; s/"$//' |
    grep -E "^$1-[0-9]{8}-[0-9]{6}\.sql\.gz$" | sort -r | tail -n +$((KEEP + 1)) |
    while read -r NAME; do
      curl -sS --max-time 60 -o /dev/null -X POST https://api.dropboxapi.com/2/files/delete_v2 \
        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        --data "{\"path\":\"__DDIR__/$NAME\"}"
    done
}

TOKEN=$(dbx_token)
if [ -z "$TOKEN" ]; then
  log "Dropbox: couldn't get an access token. Reconnect Dropbox and recreate this backup."
  DBX=0
  FAILED=1
fi
`;

const SCRIPT_LOOP_START = String.raw`
log "Backup started."
for DB in __DBS__; do
  FILE="$DIR/$DB-$STAMP.sql.gz"
  if mysqldump --single-transaction --quick --routines --triggers --events "$DB" | gzip > "$FILE.part"; then
    mv "$FILE.part" "$FILE"
    log "$DB: dumped ($(du -h "$FILE" | cut -f1))"
`;

const SCRIPT_DROPBOX_UPLOAD = String.raw`    if [ "$DBX" -eq 1 ]; then
      if dbx_upload "$FILE" "__DDIR__/$(basename "$FILE")"; then
        log "$DB: uploaded to Dropbox"
      else
        FAILED=1
      fi
    fi
`;

const SCRIPT_LOOP_MIDDLE = String.raw`  else
    rm -f "$FILE.part"
    log "$DB: FAILED to dump"
    FAILED=1
    continue
  fi
  ls -1 "$DIR"/"$DB"-????????-??????.sql.gz 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | xargs -r rm -f --
`;

const SCRIPT_DROPBOX_PRUNE = String.raw`  if [ "$DBX" -eq 1 ]; then dbx_prune "$DB" || true; fi
`;

const SCRIPT_TAIL = String.raw`done

if [ "$FAILED" -eq 0 ]; then
  log "Backup finished."
else
  log "Backup finished with errors."
  exit 1
fi
`;

interface BackupCfg {
    databases: string[];
    retention: number;
    schedule: string;
}
interface DropboxCreds {
    app_key: string;
    app_secret: string;
    refresh_token: string;
    folder: string;
}

function backupScript(id: number, cfg: BackupCfg, dropbox: DropboxCreds | null): string {
    const values = {
        ID: String(id),
        DIR: dirOf(id),
        KEEP: String(cfg.retention),
        DBS: cfg.databases.join(" "),
        ENV: envOf(id),
        DDIR: dropbox?.folder ?? "",
    };

    return fill(
        SCRIPT_HEAD +
            (dropbox ? SCRIPT_DROPBOX_SETUP : "") +
            SCRIPT_LOOP_START +
            (dropbox ? SCRIPT_DROPBOX_UPLOAD : "") +
            SCRIPT_LOOP_MIDDLE +
            (dropbox ? SCRIPT_DROPBOX_PRUNE : "") +
            SCRIPT_TAIL,
        values,
    );
}

function installScript(id: number, cfg: BackupCfg, dropbox: DropboxCreds | null): string {
    const lines = [
        "set -e",
        'command -v mysqldump >/dev/null 2>&1 || { echo "mysqldump is not installed. Install MySQL from the Packages page first." >&2; exit 4; }',
        'command -v flock >/dev/null 2>&1 || { echo "flock is not installed on this server (util-linux)." >&2; exit 4; }',
        '[ -d /etc/cron.d ] || { echo "Cron is not installed on this server. Install it first (Packages)." >&2; exit 5; }',
    ];
    if (dropbox) {
        lines.push('command -v curl >/dev/null 2>&1 || { echo "curl is not installed on this server." >&2; exit 4; }');
    }

    lines.push(
        `mkdir -p ${ROOT_DIR} ${ETC_DIR}`,
        `chmod 700 ${ROOT_DIR} ${ETC_DIR}`,
        `cat > ${scriptOf(id)} <<'TYLIX_BACKUP_EOF'`,
        backupScript(id, cfg, dropbox).trimEnd(),
        "TYLIX_BACKUP_EOF",
        `chmod 700 ${scriptOf(id)}`,
    );

    if (dropbox) {
        lines.push(
            "umask 077",
            `cat > ${envOf(id)} <<'TYLIX_ENV_EOF'`,
            `DROPBOX_APP_KEY='${dropbox.app_key}'`,
            `DROPBOX_APP_SECRET='${dropbox.app_secret}'`,
            `DROPBOX_REFRESH_TOKEN='${dropbox.refresh_token}'`,
            "TYLIX_ENV_EOF",
            `chmod 600 ${envOf(id)}`,
        );
    }

    lines.push(
        `cat > ${cronOf(id)} <<'TYLIX_CRON_EOF'`,
        "PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin",
        `${cfg.schedule} root ${scriptOf(id)} >> ${logOf(id)} 2>&1`,
        "TYLIX_CRON_EOF",
        `chmod 644 ${cronOf(id)}`,
        `touch ${logOf(id)}`,
        `chmod 600 ${logOf(id)}`,
        "if [ -d /etc/logrotate.d ] && [ ! -f /etc/logrotate.d/tylix-backup ]; then",
        "  printf '%s\\n' '/var/log/tylix-backup-*.log {' '  weekly' '  rotate 4' '  compress' '  missingok' '  notifempty' '  copytruncate' '}' > /etc/logrotate.d/tylix-backup",
        "fi",
    );

    return lines.join("\n");
}

/** Removes the schedule, script, credentials and log. The backup files stay. */
function removeScript(id: number): string {
    return `rm -f ${cronOf(id)} ${scriptOf(id)} ${envOf(id)} ${logOf(id)} ${logOf(id)}.*`;
}

function runScript(id: number): string {
    return [
        `[ -x ${scriptOf(id)} ] || { echo "The backup script isn't installed on this server. Recreate the backup." >&2; exit 3; }`,
        `nohup ${scriptOf(id)} >> ${logOf(id)} 2>&1 </dev/null &`,
        "exit 0",
    ].join("\n");
}

function listScript(id: number): string {
    return [
        `cd ${dirOf(id)} 2>/dev/null || exit 0`,
        "for f in *.sql.gz; do",
        '  [ -e "$f" ] || continue',
        `  printf '%s\\t%s\\t%s\\n' "$f" "$(stat -c %s "$f")" "$(stat -c %Y "$f")"`,
        "done",
    ].join("\n");
}

function downloadScript(id: number, name: string): string {
    return [
        `f=${dirOf(id)}/${name}`,
        '[ -f "$f" ] || { echo "That backup file no longer exists." >&2; exit 3; }',
        's=$(stat -c %s "$f")',
        `[ "$s" -le ${MAX_DOWNLOAD} ] || { echo too_large >&2; exit 7; }`,
        'base64 -w0 "$f"',
    ].join("\n");
}

// ---- Dropbox check (runs in the deployer, never on the server) ---------------

async function checkDropbox(key: string, secret: string, refresh: string): Promise<string | null> {
    try {
        const basic = Buffer.from(`${key}:${secret}`).toString("base64");
        const tokenRes = await fetch("https://api.dropboxapi.com/oauth2/token", {
            method: "POST",
            headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh }).toString(),
        });
        if (!tokenRes.ok) return "Dropbox rejected the app key, app secret or refresh token.";

        const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
        if (!token) return "Dropbox didn't return an access token.";

        const listRes = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ path: "", limit: 1 }),
        });
        if (!listRes.ok) {
            return "Dropbox accepted the login, but the app is missing permissions. Enable files.content.write and files.metadata.read, then generate a new refresh token.";
        }
        return null;
    } catch {
        return "Couldn't reach Dropbox. Try again in a moment.";
    }
}

const publicStorage = (s: StorageRow) => ({
    id: s.id,
    name: s.name,
    provider: s.provider,
    app_key: s.app_key,
    created_at: s.created_at,
});

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    // ---- storages (Dropbox connections, shared by the team) -----------------
    router.get("/api/backup-storages", auth(async (req, res) => {
        const teamId = requireTeam(req as any, res as any);
        if (!teamId) return;

        const all = (await BackupStorage.all()) as StorageRow[];
        const own: StorageRow[] = [];
        for (const s of all) {
            if (await storageOnTeam(s, teamId)) own.push(s);
        }
        own.sort((a, b) => a.id - b.id);

        return res.json(own.map(publicStorage));
    }));

    router.post("/api/backup-storages", write(async (req, res) => {
        const teamId = requireTeam(req as any, res as any);
        if (!teamId) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
        const name = str(body.name);
        const key = str(body.app_key);
        const secret = str(body.app_secret);
        const refresh = str(body.refresh_token);

        if (!name || name.length > 100) {
            res.status(422);
            return res.json({ error: "Give the connection a name (100 characters or fewer)." });
        }
        if (![key, secret, refresh].every((v) => SAFE_SECRET.test(v))) {
            res.status(422);
            return res.json({ error: "App key, app secret and refresh token may only contain letters, numbers, - and _." });
        }

        const problem = await checkDropbox(key, secret, refresh);
        if (problem) {
            res.status(422);
            return res.json({ error: problem });
        }

        const row = (await BackupStorage.create({
            user_id: req.user?.userId,
            team_id: teamId,
            name,
            provider: "dropbox",
            app_key: key,
            app_secret: CryptoService.encrypt(secret),
            refresh_token: CryptoService.encrypt(refresh),
        })) as StorageRow | null;

        if (!row) {
            res.status(500);
            return res.json({ error: "Could not save the connection." });
        }

        res.status(201);
        return res.json(publicStorage(row));
    }));

    router.delete("/api/backup-storages/:sid", write(async (req, res) => {
        const teamId = requireTeam(req as any, res as any);
        if (!teamId) return;

        const s = (await BackupStorage.find(req.params.sid)) as StorageRow | null;
        if (!s || !(await storageOnTeam(s, teamId))) {
            res.status(404);
            return res.json({ error: "Connection not found." });
        }

        const used = ((await ServerBackup.all()) as BackupRow[]).some((b) => Number(b.storage_id) === s.id);
        if (used) {
            res.status(409);
            return res.json({ error: "A backup still uses this connection. Delete that backup first." });
        }

        await BackupStorage.delete(s.id);
        res.status(204);
        return res.end();
    }));

    // ---- backups -------------------------------------------------------------
    router.get("/api/servers/:id/backups", auth(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const storages = new Map(
            ((await BackupStorage.all()) as StorageRow[]).map((s) => [s.id, s.name] as const),
        );
        const rows = ((await ServerBackup.all()) as BackupRow[])
            .filter((b) => b.server_id === server.id)
            .sort((a, b) => a.id - b.id);

        return res.json(
            rows.map((b) => ({
                id: b.id,
                name: b.name,
                databases: namesOf(b),
                storage_id: Number(b.storage_id),
                storage_name: Number(b.storage_id) > 0 ? storages.get(Number(b.storage_id)) ?? "Dropbox" : "This server",
                schedule: b.schedule,
                retention: Number(b.retention),
                created_at: b.created_at,
            })),
        );
    }));

    router.post("/api/servers/:id/backups", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const teamId = Number(server.team_id);

        const body = (req.body ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
        const name = str(body.name);
        const schedule = checkSchedule(str(body.schedule).replace(/\s+/g, " "));
        const retention = Number(body.retention === undefined || body.retention === "" ? 7 : body.retention);
        const storageId = Number(body.storage_id) || 0;
        const ids = Array.isArray(body.database_ids) ? body.database_ids.map(Number) : [];

        const fail = (error: string) => {
            res.status(422);
            return res.json({ error });
        };

        if (!name || name.length > 100 || [...name].some((c) => c.charCodeAt(0) < 32)) {
            return fail("Give the backup a name (100 characters or fewer).");
        }
        if (!schedule) {
            return fail("Schedule must be five fields such as 0 2 * * * (numbers, *, / , -) or one of @hourly, @daily, @weekly, @monthly, @yearly.");
        }
        if (!Number.isInteger(retention) || retention < 1 || retention > 60) {
            return fail("Keep between 1 and 60 backups per database.");
        }
        if (ids.length === 0) return fail("Select at least one database.");

        // Databases belong to the server, and the server belongs to the team.
        const owned = ((await ServerDatabase.all()) as DbRow[]).filter((d) => d.server_id === server.id);
        const chosen = owned.filter((d) => ids.includes(d.id));
        if (chosen.length !== new Set(ids).size || chosen.some((d) => !SAFE_NAME.test(d.name))) {
            return fail("One of the selected databases doesn't exist on this server.");
        }
        const databases = chosen.map((d) => d.name).sort();

        let dropbox: DropboxCreds | null = null;
        if (storageId > 0) {
            const s = (await BackupStorage.find(storageId)) as StorageRow | null;
            if (!s || !(await storageOnTeam(s, teamId))) return fail("Choose a storage connection.");

            const slug = String(server.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "server";
            dropbox = {
                app_key: s.app_key,
                app_secret: CryptoService.decrypt(s.app_secret),
                refresh_token: CryptoService.decrypt(s.refresh_token),
                folder: `/tylix-backups/${slug}-${server.id}`,
            };
        }

        const row = (await ServerBackup.create({
            user_id: req.user?.userId,
            server_id: server.id,
            name,
            databases: JSON.stringify(databases),
            storage_id: storageId,
            schedule,
            retention,
        })) as BackupRow | null;

        if (!row) {
            res.status(500);
            return res.json({ error: "Could not save the backup." });
        }

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, installScript(row.id, { databases, retention, schedule }, dropbox)), 60_000);
        if (r.code !== 0) {
            await ServerBackup.delete(row.id);
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not set up the backup on the server." });
        }

        res.status(201);
        return res.json({ id: row.id, name, databases, storage_id: storageId, schedule, retention });
    }));

    router.delete("/api/servers/:id/backups/:bid", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const backup = await ownedBackup(req, res, server);
        if (!backup) return;

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, removeScript(backup.id)), 60_000);
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not remove the backup from the server." });
        }

        await ServerBackup.delete(backup.id);
        res.status(204);
        return res.end();
    }));

    router.post("/api/servers/:id/backups/:bid/run", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const backup = await ownedBackup(req, res, server);
        if (!backup) return;

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, runScript(backup.id)), 30_000);
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not start the backup." });
        }

        res.status(202);
        return res.json({ ok: true });
    }));

    router.get("/api/servers/:id/backups/:bid/log", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const backup = await ownedBackup(req, res, server);
        if (!backup) return;

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, `tail -n 200 ${logOf(backup.id)} 2>&1 || true`));
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not read the log." });
        }
        return res.json({ log: r.stdout.trim() || "No output yet." });
    }));

    // ---- backup files ----------------------------------------------------------
    router.get("/api/servers/:id/backups/:bid/files", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const backup = await ownedBackup(req, res, server);
        if (!backup) return;

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, listScript(backup.id)));
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not list the backup files." });
        }

        const files = r.stdout
            .split("\n")
            .map((line) => line.split("\t"))
            .filter((p) => p.length === 3 && FILE_NAME.test(p[0]))
            .map((p) => ({ name: p[0], size: Number(p[1]), mtime: Number(p[2]) }))
            .sort((a, b) => b.mtime - a.mtime);

        return res.json(files);
    }));

    router.get("/api/servers/:id/backups/:bid/files/download", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const backup = await ownedBackup(req, res, server);
        if (!backup) return;

        const name = qs(req, "name");
        if (!FILE_NAME.test(name)) {
            res.status(422);
            return res.json({ error: "Invalid file name." });
        }

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, downloadScript(backup.id, name)), 300_000);

        if (r.code === 7) {
            res.status(413);
            return res.json({
                error: `That file is over ${MAX_DOWNLOAD / 1024 / 1024} MB. Store backups in Dropbox, or copy it from ${dirOf(backup.id)}/ with scp.`,
            });
        }
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not read the backup file." });
        }

        // ASSUMPTION: the response exposes setHeader() and end(Buffer) like Node's ServerResponse.
        const raw = res as unknown as { setHeader: (k: string, v: string) => void; end: (b?: Buffer) => void };
        const data = Buffer.from(r.stdout.trim(), "base64");
        res.status(200);
        raw.setHeader("Content-Type", "application/gzip");
        raw.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        raw.setHeader("Content-Length", String(data.length));
        return raw.end(data);
    }));

    router.delete("/api/servers/:id/backups/:bid/files", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const backup = await ownedBackup(req, res, server);
        if (!backup) return;

        const name = qs(req, "name");
        if (!FILE_NAME.test(name)) {
            res.status(422);
            return res.json({ error: "Invalid file name." });
        }

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, `rm -f ${dirOf(backup.id)}/${name}`));
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not delete the file." });
        }

        res.status(204);
        return res.end();
    }));
}