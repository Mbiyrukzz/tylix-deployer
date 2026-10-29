/**
 * GET  /api/servers/:id/packages          catalog + what is installed (asks the server over SSH)
 * GET  /api/servers/:id/packages/task     latest install task (cheap, used for polling)
 * POST /api/servers/:id/packages          queue an install { packages: string[], code? }
 * POST /api/servers/:id/packages/upgrade  queue an update of everything already installed { code? }
 *
 * Team-scoped. Any member can look; installing or updating needs the admin role.
 * Installing and updating answer 402 while the team is view only (withBillingLock).
 *
 * Installing and updating run root commands, so they have the same gates as
 * the server terminal, in this order: team, rate limit, plan active, server
 * lookup (404), admin role (403), body check (422), another install running
 * (409), then two-factor last (a valid body.code when the caller has 2FA on),
 * so a refused request never spends a code. Every accepted request is written
 * to the server log.
 */

import type { Router } from "@tylix/core";
import { dispatch } from "@tylix/core";
import { Server } from "../models/Server.js";
import { ServerTask } from "../models/ServerTask.js";
import { CryptoService } from "../services/CryptoService.js";
import { PACKAGES, UPGRADE_ID, detectInstalled } from "../services/Installers.js";
import { createGuard, audit, requireStepUp } from "../services/RouteGuard.js";
import { requireActive } from "../services/EntitlementService.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { withBillingLock } from "../services/BillingLock.js";

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
const MAX_PACKAGES = 50;

// Installing opens a root shell's worth of commands: keep it slow. Looking
// opens an SSH connection per request, so it gets its own, looser limit.
const installGuard = createGuard({ max: 10, windowMs: 15 * 60_000, scope: "user", what: "package installs" });
const lookGuard = createGuard({ max: 30, windowMs: 60_000, scope: "user", what: "package lookups" });

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

const BUSY = "An install is already running on this server. Wait for it to finish.";

/**
 * Queues one task for the server and answers 202. Shared by the install and the
 * update routes: one install or update at a time per server (409 otherwise).
 */
async function queueTask(req: any, res: any, server: ServerRow, ids: string[]) {
    if (isActive(await latestTask(server.id))) {
        res.status(409);
        return res.json({ error: BUSY });
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
}

export async function routes(router: Router, { auth: baseAuth }: { auth: (handler: Handler) => Handler }) {
    // Every POST, PUT, PATCH and DELETE below answers 402 while the team is view only.
    const auth = withBillingLock(baseAuth);

    /**
     * Every gate for an install or an update. `ids` is the list to install, or
     * null to read it from the body. Returns the server and ids when the
     * request may go on; otherwise it has already answered.
     */
    async function gate(req: any, res: any, fixedIds: string[] | null) {
        const teamId = requireTeam(req, res);
        if (!teamId) return null;
        if (!installGuard(req, res)) return null;
        if (!(await requireActive(res, teamId))) return null;

        const server = await ownServer(req.params.id, teamId);
        if (!server) {
            res.status(404);
            res.json({ error: "Server not found." });
            return null;
        }

        if (!requireRole(req, res, "admin")) return null;

        let ids = fixedIds;
        if (!ids) {
            // ADAPT: assumes the parsed JSON body is on req.body.
            const raw = (req.body as { packages?: unknown } | undefined)?.packages;
            const known = new Set(PACKAGES.map((p) => p.id));

            if (
                !Array.isArray(raw) ||
                raw.length === 0 ||
                raw.length > MAX_PACKAGES ||
                !raw.every((i) => typeof i === "string" && known.has(i))
            ) {
                res.status(422);
                res.json({ error: "Choose at least one package from the list." });
                return null;
            }
            ids = Array.from(new Set(raw as string[]));
        }

        if (isActive(await latestTask(server.id))) {
            res.status(409);
            res.json({ error: BUSY });
            return null;
        }

        // Last gate before anything runs: second factor, if the caller has one on.
        if (!(await requireStepUp(req, res, "install packages on this server"))) return null;

        await audit({
            userId: Number(req.user?.userId),
            teamId,
            serverId: server.id,
            event: "server.packages_install_started",
            level: "warning",
            message: ids[0] === UPGRADE_ID ? "Updating the installed packages." : `Installing packages: ${ids.join(", ")}.`,
            meta: { packages: ids },
        });

        return { server, ids };
    }

    router.get(
        "/api/servers/:id/packages",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;
            if (!lookGuard(req as any, res as any)) return;

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
        auth(async (req, res) => {
            const ok = await gate(req, res, null);
            if (!ok) return;
            return queueTask(req, res, ok.server, ok.ids);
        }),
    );

    // Update everything already on the server to the latest version. Body: { code? } only.
    router.post(
        "/api/servers/:id/packages/upgrade",
        auth(async (req, res) => {
            const ok = await gate(req, res, [UPGRADE_ID]);
            if (!ok) return;
            return queueTask(req, res, ok.server, ok.ids);
        }),
    );
}