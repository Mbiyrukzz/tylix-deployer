/**
 * Feature: Server (team-scoped, encrypted SSH keys)
 *
 * Follows the shape of the generated PostController, with three additions
 * because servers hold credentials:
 *
 *   - ssh_key is encrypted with CryptoService before it is stored and is
 *     NEVER returned to the client (responses carry has_ssh_key instead)
 *   - a server that belongs to another team answers 404, not 403, so the API
 *     never confirms that someone else's server id exists
 *   - changing host / port / user / key resets status to "pending", because
 *     the connection has not been tested with the new details
 *
 * Teams: servers belong to a team (team_id), not to one user. user_id is
 * the person who added the server. Everyone on the team sees it.
 *
 * Roles: any member can list and view servers; adding, editing and deleting
 * one needs the admin role. The team check runs first, so a server on
 * another team is a 404 and never a 403.
 *
 * Plans: adding a server is checked against the team's plan
 * (EntitlementService). Editing and deleting are never limited.
 *
 * Two-factor: when the caller has two-factor turned on (authenticator or
 * SMS), adding and deleting a server also need a valid code (requireStepUp:
 * wrong codes are counted and lock the user out). That check runs last,
 * after every check that can refuse the request.
 *
 * Rate limit: adding servers is limited per team.
 *
 * Deleting a server is refused while it still has sites, so no site record
 * is ever left pointing at a server that is gone. The records that hang off
 * the server are removed by ServerRecords.
 *
 * Every state change is written to the server log (ServerLogService). Log
 * entries never contain the key itself, only the fact that it changed.
 * Log entries record who acted (the caller), not who added the server.
 * Deleting removes the server's own log with it, so the deletion is logged
 * without a server id and stays in the team's history.
 *
 * All routes sit behind requireAuth ("auth": true in feature.json), so
 * req.user.userId is always present here. req.user.teamId comes from the
 * auth hook; requireTeam() answers 503 if it couldn't be loaded.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Server } from "../models/Server.js";
import { Provision } from "../models/Provision.js";
import { validateServer, normalizeServer } from "../validators/ServerValidator.js";
import { CryptoService } from "../services/CryptoService.js";
import { ServerLogService } from "../services/ServerLogService.js";
import { ServerRecords } from "../services/ServerRecords.js";
import { createGuard, audit, requireStepUp } from "../services/RouteGuard.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { requireWithin, requireActive } from "../services/EntitlementService.js";

interface ServerRow {
    id: number;
    user_id: number;
    team_id: number | null;
    name: string;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
    status: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

const addGuard = createGuard({ max: 10, windowMs: 15 * 60_000, scope: "team", what: "server additions" });

/** Strips the encrypted key from anything that leaves the API. */
function toPublic(row: ServerRow) {
    const { ssh_key, ...rest } = row;
    return { ...rest, has_ssh_key: Boolean(ssh_key) };
}

/** Loads a server and answers 404 itself if it is missing or not on the caller's team. */
async function findOwned(req: TylixRequest, res: TylixResponse): Promise<ServerRow | null> {
    const teamId = requireTeam(req, res);
    if (!teamId) return null;

    const server = (await Server.find(req.params.id)) as ServerRow | null;

    if (!server || Number(server.team_id) !== teamId) {
        res.status(404);
        res.json({ error: "Server not found." });
        return null;
    }

    return server;
}

async function isDuplicate(
    teamId: number,
    host: string,
    port: number,
    exceptId?: number,
): Promise<boolean> {
    // TODO: swap for a WHERE query once confirmed in the ORM; all() + filter
    // mirrors the generated PostController and is fine for small tables.
    const servers = (await Server.all()) as ServerRow[];
    return servers.some(
        (s) =>
            Number(s.team_id) === teamId &&
            s.host === host &&
            Number(s.port) === port &&
            s.id !== exceptId,
    );
}

export class ServerController {
    /** Any team member. */
    async index(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;

        const servers = (await Server.all()) as ServerRow[];
        const own = servers
            .filter((s) => Number(s.team_id) === teamId)
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return res.json(own.map(toPublic));
    }

    /** Any team member. */
    async show(req: TylixRequest, res: TylixResponse) {
        const server = await findOwned(req, res);
        if (!server) return;

        return res.json(toPublic(server));
    }

    /**
     * Admin only. Limited by the team's plan.
     * With two-factor on, a valid code (body.code) is required.
     */
    async store(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, teamId))) return;
        if (!addGuard(req, res)) return;

        const result = validateServer(req.body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeServer(req.body);

        if (await isDuplicate(teamId, input.host, input.port)) {
            res.status(409);
            return res.json({ error: "Your team has already added a server with that host and port." });
        }

        if (!(await requireWithin(res, teamId, "servers"))) return;

        // Last gate before the write: second factor, if the caller has one on.
        if (!(await requireStepUp(req, res, "add this server"))) return;

        const server = (await Server.create({
            name: input.name,
            host: input.host,
            port: input.port,
            ssh_user: input.ssh_user,
            ssh_key: CryptoService.encrypt(input.ssh_key),
            status: "pending",
            user_id: req.user?.userId,
            team_id: teamId,
        })) as ServerRow | null;

        if (!server) {
            res.status(500);
            return res.json({ error: "Could not save the server." });
        }

        await ServerLogService.record({
            userId: Number(req.user?.userId),
            teamId,
            serverId: server.id,
            event: "server.created",
            level: "success",
            message: `Server "${server.name}" was added.`,
            meta: { host: server.host, port: Number(server.port), ssh_user: server.ssh_user },
        });

        res.status(201);
        return res.json(toPublic(server));
    }

    /** Admin only. Another team's server answers 404 before the role is checked. */
    async update(req: TylixRequest, res: TylixResponse) {
        const server = await findOwned(req, res);
        if (!server) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;

        const teamId = Number(server.team_id);
        const actor = Number(req.user?.userId);

        const result = validateServer(req.body, { isUpdate: true });
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeServer(req.body);

        if (await isDuplicate(teamId, input.host, input.port, server.id)) {
            res.status(409);
            return res.json({ error: "Your team has already added a server with that host and port." });
        }

        const patch: Record<string, unknown> = {
            name: input.name,
            host: input.host,
            port: input.port,
            ssh_user: input.ssh_user,
        };

        if (input.ssh_key) {
            patch.ssh_key = CryptoService.encrypt(input.ssh_key);
        }

        const connectionChanged =
            input.host !== server.host ||
            input.port !== Number(server.port) ||
            input.ssh_user !== server.ssh_user ||
            Boolean(input.ssh_key);

        if (connectionChanged) {
            patch.status = "pending";
        }

        // Work out what changed BEFORE the write, while `server` is still the old row.
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        if (input.name !== server.name) changes.name = { from: server.name, to: input.name };
        if (input.host !== server.host) changes.host = { from: server.host, to: input.host };
        if (input.port !== Number(server.port)) {
            changes.port = { from: Number(server.port), to: input.port };
        }
        if (input.ssh_user !== server.ssh_user) {
            changes.ssh_user = { from: server.ssh_user, to: input.ssh_user };
        }
        const keyRotated = Boolean(input.ssh_key);
        const previousStatus = server.status;

        // Re-read the row after the write so we never depend on update()'s return value.
        await Server.update(server.id, patch);
        const fresh = (await Server.find(server.id)) as ServerRow | null;

        if (!fresh) {
            res.status(500);
            return res.json({ error: "Could not reload the server after saving." });
        }

        const changedFields = [...Object.keys(changes), ...(keyRotated ? ["ssh_key"] : [])];

        if (changedFields.length > 0) {
            await ServerLogService.record({
                userId: actor,
                teamId,
                serverId: server.id,
                event: "server.updated",
                message: `Server updated: ${changedFields.join(", ")}.`,
                meta: { changes, ssh_key_replaced: keyRotated },
            });
        }

        if (keyRotated) {
            await ServerLogService.record({
                userId: actor,
                teamId,
                serverId: server.id,
                event: "server.key_replaced",
                level: "warning",
                message: "The SSH private key was replaced.",
            });
        }

        if (connectionChanged && previousStatus !== "pending") {
            await ServerLogService.record({
                userId: actor,
                teamId,
                serverId: server.id,
                event: "server.status_reset",
                level: "warning",
                message: "Connection details changed, so the status was reset to pending.",
                meta: { from: previousStatus, to: "pending" },
            });
        }

        return res.json(toPublic(fresh));
    }

    /**
     * Admin only. Another team's server answers 404 before the role is checked.
     * With two-factor on, a valid code (body or query `code`) is required.
     */
    async destroy(req: TylixRequest, res: TylixResponse) {
        const server = await findOwned(req, res);
        if (!server) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;

        const teamId = Number(server.team_id);
        const actor = Number(req.user?.userId);

        const provisions = (await Provision.all()) as { server_id: number; status: string }[];
        if (provisions.some((p) => Number(p.server_id) === server.id && p.status !== "deleted")) {
            await ServerLogService.record({
                userId: actor,
                teamId,
                serverId: server.id,
                event: "server.delete_blocked",
                level: "warning",
                message: "Delete refused: this server was created by the deployer.",
            });

            res.status(409);
            return res.json({
                error: "This server was created by the deployer. Delete it from the Provisioned servers list so it is removed at your cloud provider too.",
            });
        }

        // Sites must be deleted first (each one cleans up its own files, nginx
        // config, user and database on the machine), so nothing is left orphaned.
        const siteCount = await ServerRecords.siteCount(server.id);
        if (siteCount > 0) {
            await ServerLogService.record({
                userId: actor,
                teamId,
                serverId: server.id,
                event: "server.delete_blocked",
                level: "warning",
                message: `Delete refused: the server still has ${siteCount} site${siteCount === 1 ? "" : "s"}.`,
                meta: { sites: siteCount },
            });

            res.status(409);
            return res.json({
                error:
                    siteCount === 1
                        ? "This server still has 1 site. Delete it first, then delete the server."
                        : `This server still has ${siteCount} sites. Delete them first, then delete the server.`,
            });
        }

        // Last gate before the irreversible step: second factor, if the caller has one on.
        if (!(await requireStepUp(req, res, "delete this server"))) return;

        // Databases, DB users, SSH keys, workers, cron jobs, backups, firewall
        // rules, tasks and the server's log all go with it.
        await ServerRecords.removeAll(server.id);

        // The server's own log is gone now, so this entry carries no server id.
        await audit({
            userId: actor,
            teamId,
            serverId: null,
            event: "server.deleted",
            level: "warning",
            message: `Server "${server.name}" was deleted.`,
            meta: { host: server.host, port: Number(server.port), ssh_user: server.ssh_user },
        });

        res.status(204);
        return res.end();
    }
}