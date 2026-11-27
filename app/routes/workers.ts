/**
 * Supervisor workers on a server. Team-scoped: a server on another team
 * answers 404. Any member can list workers and see whether they are running;
 * creating, starting, stopping, restarting, reading logs and deleting need
 * the admin role (they run commands as root over SSH).
 *
 * GET    /api/servers/:id/workers                       any member
 * GET    /api/servers/:id/workers/status                any member
 * POST   /api/servers/:id/workers                       admin
 * POST   /api/servers/:id/workers/:wid/:action          admin: start | stop | restart
 * GET    /api/servers/:id/workers/:wid/log              admin
 * DELETE /api/servers/:id/workers/:wid                  admin
 */

import type { Router } from "@tylix/core";
import { Server } from "../models/Server.js";
import { ServerWorker } from "../models/ServerWorker.js";
import { CryptoService } from "../services/CryptoService.js";
import { sshExec, type SshTarget } from "../services/Ssh.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { sq, program, logPath, NO_SUPERVISOR, installScript, removeScript } from "../services/WorkerFiles.js";

type Handler = Parameters<Router["post"]>[1];
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

interface ServerRow {
    id: number; user_id: number; team_id: number | null; host: string; port: number; ssh_user: string; ssh_key: string;
    [key: string]: unknown;
}
interface WorkerRow {
    id: number; user_id: number; server_id: number; name: string; command: string;
    directory: string; ssh_user: string; processes: number; created_at: string;
    [key: string]: unknown;
}

const UNIX_USER = /^[a-z_][a-z0-9_-]{0,31}$/i;
const DIRECTORY = /^\/[A-Za-z0-9_.\/-]*$/;
const ACTIONS = ["start", "stop", "restart"];

function targetFor(server: ServerRow): SshTarget {
    return {
        host: server.host,
        port: Number(server.port),
        user: server.ssh_user,
        privateKey: CryptoService.decrypt(server.ssh_key),
    };
}

/** Supervisor config lives in /etc, so the script runs as root (via sudo when we aren't). */
function asRoot(connectUser: string, script: string): string {
    return `${connectUser === "root" ? "" : "sudo -n "}sh -c ${sq(script)}`;
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

/** A worker belongs to the team of its server, so checking the server is enough. */
async function ownedWorker(req: Req, res: Res, server: ServerRow): Promise<WorkerRow | null> {
    const w = (await ServerWorker.find(req.params.wid)) as WorkerRow | null;
    if (!w || w.server_id !== server.id) {
        res.status(404);
        res.json({ error: "Worker not found." });
        return null;
    }
    return w;
}

function validate(body: Record<string, unknown>) {
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const name = str(body.name);
    const command = str(body.command);
    const directory = str(body.directory);
    const user = str(body.user);
    const processes = Number(body.processes === undefined || body.processes === "" ? 1 : body.processes);

    // A newline in any field would let someone add extra lines to the Supervisor config.
    const hasControl = (v: string) => [...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

    if (!name || name.length > 100 || hasControl(name)) return { error: "Give the worker a name (100 characters or fewer)." };
    if (!command || command.length > 500 || hasControl(command)) return { error: "Command is required, on a single line (500 characters or fewer)." };
    if (!DIRECTORY.test(directory) || directory.includes("..")) return { error: "Directory must be an absolute path such as /home/tylix/app/current." };
    if (!UNIX_USER.test(user)) return { error: "Choose a valid server user." };
    if (!Number.isInteger(processes) || processes < 1 || processes > 20) return { error: "Processes must be a whole number from 1 to 20." };

    return { value: { name, command, directory, user, processes } };
}


function parseStatus(out: string) {
    const map: Record<string, { running: number; total: number; states: string[] }> = {};
    for (const line of out.split("\n")) {
        const m = /^tylix-worker-(\d+):\S+\s+(\w+)/.exec(line.trim());
        if (!m) continue;
        const entry = map[m[1]] ?? { running: 0, total: 0, states: [] };
        entry.total += 1;
        if (m[2] === "RUNNING") entry.running += 1;
        entry.states.push(m[2]);
        map[m[1]] = entry;
    }
    return map;
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get("/api/servers/:id/workers", auth(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const rows = ((await ServerWorker.all()) as WorkerRow[])
            .filter((w) => w.server_id === server.id)
            .sort((a, b) => a.id - b.id);
        return res.json(rows);
    }));

    router.get("/api/servers/:id/workers/status", auth(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, `${NO_SUPERVISOR}\nsupervisorctl status || true`));
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not read worker status." });
        }
        return res.json(parseStatus(r.stdout));
    }));

    router.post("/api/servers/:id/workers", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;

        const parsed = validate((req.body ?? {}) as Record<string, unknown>);
        if (!("value" in parsed) || !parsed.value) {
            res.status(422);
            return res.json({ error: "error" in parsed ? parsed.error : "Invalid worker." });
        }
        const v = parsed.value;

        const worker = (await ServerWorker.create({
            user_id: req.user?.userId,
            server_id: server.id,
            name: v.name,
            command: v.command,
            directory: v.directory,
            ssh_user: v.user,
            processes: v.processes,
        })) as WorkerRow | null;

        if (!worker) {
            res.status(500);
            return res.json({ error: "Could not save the worker." });
        }

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, installScript(worker.id, v)), 60_000);

        if (r.code !== 0) {
            await ServerWorker.delete(worker.id);
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not create the worker on the server." });
        }

        res.status(201);
        return res.json(worker);
    }));

    router.post("/api/servers/:id/workers/:wid/:action", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const worker = await ownedWorker(req, res, server);
        if (!worker) return;

        const action = String(req.params.action);
        if (!ACTIONS.includes(action)) {
            res.status(422);
            return res.json({ error: "Unknown action." });
        }

        const t = targetFor(server);
        const r = await sshExec(
            t,
            asRoot(t.user, `${NO_SUPERVISOR}\nsupervisorctl ${action} ${sq(program(worker.id) + ":*")}`),
            60_000,
        );

        const benign = /already started|not running/i.test(r.stdout + r.stderr);
        if (r.code !== 0 && !benign) {
            res.status(502);
            return res.json({ error: (r.stderr || r.stdout).trim() || `Could not ${action} the worker.` });
        }
        return res.json({ ok: true });
    }));

    // The log console polls this while it's open: the tail of the log plus
    // each process's live state (supervisorctl's "pid 123, uptime 0:04:10").
    // ?lines= picks how much of the tail (50 to 2000, default 500).
    router.get("/api/servers/:id/workers/:wid/log", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const worker = await ownedWorker(req, res, server);
        if (!worker) return;

        const query = (req as { query?: Record<string, unknown> }).query ?? {};
        const wanted = Math.floor(Number(query.lines ?? 500));
        const lines = Number.isFinite(wanted) ? Math.min(2000, Math.max(50, wanted)) : 500;

        const marker = "__TYLIX_LOG__";
        const script = [
            `supervisorctl status ${sq(program(worker.id) + ":*")} 2>/dev/null || true`,
            `echo ${marker}`,
            `if [ -f ${logPath(worker.id)} ]; then tail -n ${lines} ${logPath(worker.id)}; fi`,
        ].join("\n");

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, script));
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not read the log." });
        }

        const cut = r.stdout.indexOf(marker);
        const head = cut === -1 ? "" : r.stdout.slice(0, cut);
        const log = cut === -1 ? r.stdout : r.stdout.slice(cut + marker.length).replace(/^\r?\n/, "");

        const processes = head
            .split("\n")
            .map((line) => /^tylix-worker-\d+:(\S+)\s+(\w+)\s*(.*)$/.exec(line.trim()))
            .filter((m): m is RegExpExecArray => m !== null)
            .map((m) => ({ name: m[1], state: m[2], detail: m[3].trim() }));

        return res.json({
            log: log.replace(/\s+$/, ""),
            lines,
            processes,
            running: processes.filter((p) => p.state === "RUNNING").length,
            total: processes.length,
            read_at: new Date().toISOString(),
        });
    }));

    router.delete("/api/servers/:id/workers/:wid", write(async (req, res) => {
        const server = await ownedServer(req, res);
        if (!server) return;
        const worker = await ownedWorker(req, res, server);
        if (!worker) return;

        const t = targetFor(server);
        const r = await sshExec(t, asRoot(t.user, removeScript(worker.id)), 60_000);
        if (r.code !== 0) {
            res.status(502);
            return res.json({ error: r.stderr.trim() || "Could not remove the worker from the server." });
        }

        await ServerWorker.delete(worker.id);
        res.status(204);
        return res.end();
    }));
}