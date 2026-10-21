/**
 * Cron jobs on a server (team-scoped). A server on another team answers 404.
 * Any member can list the jobs; creating, running, reading logs and deleting
 * need the admin role (they run commands as root over SSH).
 * Writes answer 402 while the team is view only (withBillingLock).
 */

import type { Router } from "@tylix/core";
import { Server } from "../models/Server.js";
import { ServerCronJob } from "../models/ServerCronJob.js";
import { CryptoService } from "../services/CryptoService.js";
import { sshExec, type SshTarget } from "../services/Ssh.js";

import { requireTeam, requireRole } from "../services/TeamScope.js";
import { withBillingLock } from "../services/BillingLock.js";
type Handler = Parameters<Router["post"]>[1];
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

interface ServerRow {
    id: number; user_id: number; team_id: number | null; host: string; port: number; ssh_user: string; ssh_key: string;
    [key: string]: unknown;
}
interface CronRow {
    id: number; user_id: number; server_id: number; name: string; command: string;
    ssh_user: string; schedule: string; created_at: string;
    [key: string]: unknown;
}

const UNIX_USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
const PRESETS = ["@reboot", "@hourly", "@daily", "@weekly", "@monthly", "@yearly"];
const FIELD = /^[0-9*\/,\-]+$/;
const FIELD_MAX = [59, 23, 31, 12, 7]; // minute, hour, day of month, month, day of week

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const jobName = (id: number) => `tylix-cron-${id}`;
// No dots in the file name: Debian's cron ignores /etc/cron.d files that contain one.
const confPath = (id: number) => `/etc/cron.d/${jobName(id)}`;
const logPath = (id: number) => `/var/log/${jobName(id)}.log`;

function targetFor(server: ServerRow): SshTarget {
    return {
        host: server.host,
        port: Number(server.port),
        user: server.ssh_user,
        privateKey: CryptoService.decrypt(server.ssh_key),
    };
}

/** /etc/cron.d is root-owned, so scripts run as root (via sudo when we aren't). */
function asRoot(connectUser: string, script: string): string {
    return `${connectUser === "root" ? "" : "sudo -n "}sh -c ${sq(script)}`;
}

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

async function ownedJob(req: Req, res: Res, server: ServerRow): Promise<CronRow | null> {
    const j = (await ServerCronJob.find(req.params.cid)) as CronRow | null;
    if (!j || j.server_id !== server.id) {
        res.status(404);
        res.json({ error: "Cron job not found." });
        return null;
    }
    return j;
}

/** Returns the cleaned schedule, or null when it isn't a valid 5-field schedule or @preset. */
function checkSchedule(raw: string): string | null {
    if (PRESETS.includes(raw)) return raw;

    const parts = raw.split(/\s+/);
    if (parts.length !== 5) return null;

    for (let i = 0; i < 5; i++) {
        const part = parts[i];
        if (!FIELD.test(part)) return null;
        if (/\/0+(,|$)/.test(part)) return null; // a step of 0 is rejected by cron
        for (const n of part.match(/\d+/g) ?? []) {
            if (Number(n) > FIELD_MAX[i]) return null;
        }
    }
    return parts.join(" ");
}

function validate(body: Record<string, unknown>) {
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const name = str(body.name);
    const command = str(body.command);
    const user = str(body.user);
    const schedule = checkSchedule(str(body.schedule).replace(/\s+/g, " "));

    // A newline would let someone add extra lines to the cron file.
    const hasControl = (v: string) => [...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

    if (!name || name.length > 100 || hasControl(name)) return { error: "Give the job a name (100 characters or fewer)." };
    if (!command || command.length > 500 || hasControl(command)) return { error: "Command is required, on a single line (500 characters or fewer)." };
    if (!schedule) return { error: "Schedule must be five fields such as */5 * * * * (numbers, *, / , -) or one of @hourly, @daily, @weekly, @monthly, @yearly, @reboot." };
    if (!UNIX_USER.test(user)) return { error: "Choose a valid server user." };

    return { value: { name, command, user, schedule } };
}

function cronFile(id: number, j: { command: string; user: string; schedule: string }): string {
    // % means "newline" in a crontab, so it has to be escaped. The command goes through
    // single-quoted bash -c, so a # in it can't comment out the redirect that follows.
    const command = j.command.replace(/%/g, "\\%");
    return [
        "PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin",
        `${j.schedule} ${j.user} /bin/bash -c ${sq(command)} >> ${logPath(id)} 2>&1`,
        "", // cron.d files must end with a newline
    ].join("\n");
}

const NO_CRON =
    '[ -d /etc/cron.d ] || { echo "Cron is not installed on this server. Install it first (Packages)." >&2; exit 4; }';
const userExists = (user: string) =>
    `id -u ${sq(user)} >/dev/null 2>&1 || { echo "User ${user} does not exist on this server." >&2; exit 3; }`;

function installScript(id: number, j: { command: string; user: string; schedule: string }): string {
    return [
        "set -e",
        NO_CRON,
        userExists(j.user),
        `cat > ${confPath(id)} <<'TYLIX_CRON_EOF'`,
        cronFile(id, j).trimEnd(),
        "TYLIX_CRON_EOF",
        `chmod 644 ${confPath(id)}`,
        `touch ${logPath(id)}`,
        `chown ${sq(j.user)} ${logPath(id)}`,
        // One shared logrotate rule so job logs never fill the disk.
        "if [ -d /etc/logrotate.d ] && [ ! -f /etc/logrotate.d/tylix-cron ]; then",
        "  printf '%s\\n' '/var/log/tylix-cron-*.log {' '  weekly' '  rotate 4' '  compress' '  missingok' '  notifempty' '  copytruncate' '}' > /etc/logrotate.d/tylix-cron",
        "fi",
    ].join("\n");
}

function removeScript(id: number): string {
    return `rm -f ${confPath(id)} ${logPath(id)} ${logPath(id)}.*`;
}

/** Runs the command once, as the job's user, and always exits 0 so ssh errors stay distinguishable. */
function runScript(j: { command: string; user: string }): string {
    return [
        userExists(j.user),
        'command -v runuser >/dev/null 2>&1 || { echo "runuser is not available on this server." >&2; exit 6; }',
        `out=$(timeout 50 runuser -u ${sq(j.user)} -- /bin/bash -c ${sq(j.command)} 2>&1)`,
        "rc=$?",
        'printf "%s\\n" "$out" | tail -c 20000',
        'echo "--- exit code $rc"',
    ].join("\n");
}

export async function routes(router: Router, { auth: baseAuth }: { auth: (handler: Handler) => Handler }) {
    // Every POST, PUT, PATCH and DELETE below answers 402 while the team is view only.
    const auth = withBillingLock(baseAuth);

    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get("/api/servers/:id/cron-jobs", auth(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const rows = ((await ServerCronJob.all()) as CronRow[])
            .filter((j) => j.server_id === server.id)
            .sort((a, b) => a.id - b.id);
        return res.json(rows);
    }));

    router.post("/api/servers/:id/cron-jobs", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const parsed = validate((req.body ?? {}) as Record<string, unknown>);
        if (!("value" in parsed) || !parsed.value) {
            res.status(422);
            return res.json({ error: "error" in parsed ? parsed.error : "Invalid cron job." });
        }
        const v = parsed.value;

        const job = (await ServerCronJob.create({
            user_id: req.user?.userId,
            server_id: server.id,
            name: v.name,
            command: v.command,
            ssh_user: v.user,
            schedule: v.schedule,
        })) as CronRow | null;

        if (!job) {
            res.status(500);
            return res.json({ error: "Could not save the cron job." });
        }

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, installScript(job.id, v)), 60_000);

        if (r.code !== 0) {
            await ServerCronJob.delete(job.id);
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not create the cron job on the server." });
        }

        res.status(201);
        return res.json(job);
    }));

    router.post("/api/servers/:id/cron-jobs/:cid/run", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const job = await ownedJob(req, res, server);
        if (!job) return;

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, runScript({ command: job.command, user: job.ssh_user })), 60_000);

        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not run the command on the server." });
        }
        return res.json({ output: r.stdout.trim() });
    }));

    router.get("/api/servers/:id/cron-jobs/:cid/log", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const job = await ownedJob(req, res, server);
        if (!job) return;

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, `tail -n 200 ${logPath(job.id)} 2>&1 || true`));
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not read the log." });
        }
        return res.json({ log: r.stdout.trim() || "No output yet." });
    }));

    router.delete("/api/servers/:id/cron-jobs/:cid", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const job = await ownedJob(req, res, server);
        if (!job) return;

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, removeScript(job.id)), 60_000);
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not remove the cron job from the server." });
        }

        await ServerCronJob.delete(job.id);
        res.status(204);
        return res.end();
    }));
}