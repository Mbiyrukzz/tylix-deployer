/**
 * GET  /api/servers/:id/packages        catalog + what is installed (asks the server over SSH)
 * GET  /api/servers/:id/packages/task   latest install task (cheap, used for polling)
 * POST /api/servers/:id/packages        queue an install { packages: string[] }

 *
 * Team-scoped. Any member can look; installing packages needs the admin role.
 */

import type { Router } from "@tylix/core";
import { dispatch } from "@tylix/core";
import { Server } from "../models/Server.js";
import { ServerTask } from "../models/ServerTask.js";
import { CryptoService } from "../services/CryptoService.js";
import { PACKAGES, detectInstalled } from "../services/Installers.js";

import { requireTeam, requireRole } from "../services/TeamScope.js";
type Handler = Parameters<Router["post"]>[1];

interface ServerRow {
    id: number;
    user_id: number;
    team_id: number | null;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
    [key: string]: unknown;
}

interface TaskRow {
    id: number;
    user_id: number;
    server_id: number;
    packages: string;
    step: string;
    status: string;
    error: string;
    updated_at: string;
    [key: string]: unknown;
}

const STALE_MS = 30 * 60 * 1000;

/** The server, only if it is on the given team. */
async function ownServer(id: unknown, teamId: number): Promise<ServerRow | null> {
    const row = (await Server.find(id as number)) as ServerRow | null;
    return row && Number(row.team_id) === teamId ? row : null;
}

// ADAPT: the one ORM call I couldn't confirm. Replace with your list/where
// query if `all()` isn't how your Model lists rows.
async function latestTask(serverId: number): Promise<TaskRow | null> {
    const all = (await ServerTask.all()) as TaskRow[];
    const mine = all.filter((t) => Number(t.server_id) === Number(serverId));
    mine.sort((a, b) => b.id - a.id);
    return mine[0] ?? null;
}

function isActive(t: TaskRow | null): boolean {
    if (!t || (t.status !== "pending" && t.status !== "running")) return false;
    // A crashed worker must not lock the server forever.
    // Assumes updated_at is UTC; adjust if yours is local time.
    const raw = String(t.updated_at);
    const ms = Date.parse(raw.includes("T") || raw.endsWith("Z") ? raw : raw.replace(" ", "T") + "Z");
    return Number.isNaN(ms) ? true : Date.now() - ms < STALE_MS;
}

function present(t: TaskRow | null) {
    if (!t) return null;
    let packages: string[] = [];
    try {
        packages = JSON.parse(t.packages);
    } catch {
        packages = [];
    }
    return { id: t.id, status: t.status, step: t.step, error: t.error, packages };
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get(
        "/api/servers/:id/packages",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const server = await ownServer(req.params.id, teamId);
            if (!server) {
                res.status(404);
                return res.json({ error: "Server not found." });
            }

            let installed: string[] = [];
            try {
                installed = await detectInstalled({
                    host: server.host,
                    port: Number(server.port),
                    user: server.ssh_user,
                    privateKey: CryptoService.decrypt(server.ssh_key),
                });
            } catch (error) {
                res.status(502);
                return res.json({ error: error instanceof Error ? error.message : "Couldn't reach the server." });
            }

            const task = await latestTask(server.id);
            return res.json({
                packages: PACKAGES.map((p) => ({
                    id: p.id,
                    label: p.label,
                    group: p.group,
                    installed: installed.includes(p.id),
                })),
                task: present(task),
            });
        }),
    );

    router.get(
        "/api/servers/:id/packages/task",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const server = await ownServer(req.params.id, teamId);
            if (!server) {
                res.status(404);
                return res.json({ error: "Server not found." });
            }
            return res.json({ task: present(await latestTask(server.id)) });
        }),
    );

    router.post(
        "/api/servers/:id/packages",
        write(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const server = await ownServer(req.params.id, teamId);
            if (!server) {
                res.status(404);
                return res.json({ error: "Server not found." });
            }

            // ADAPT: assumes the parsed JSON body is on req.body.
            const ids = (req.body as { packages?: unknown } | undefined)?.packages;
            const known = new Set(PACKAGES.map((p) => p.id));

            if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === "string" && known.has(i))) {
                res.status(422);
                return res.json({ error: "Choose at least one package from the list." });
            }

            if (isActive(await latestTask(server.id))) {
                res.status(409);
                return res.json({ error: "An install is already running on this server. Wait for it to finish." });
            }

            const task = (await ServerTask.create({
                user_id: req.user?.userId,
                server_id: server.id,
                packages: JSON.stringify(ids),
                step: "",
                status: "pending",
                error: "",
            })) as { id: number } | null;

            if (!task) {
                res.status(500);
                return res.json({ error: "Couldn't queue the install." });
            }

            await dispatch("InstallPackages", { taskId: task.id });

            res.status(202);
            return res.json({ task: present((await ServerTask.find(task.id)) as TaskRow | null) });
        }),
    );
}
