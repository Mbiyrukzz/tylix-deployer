/**
 * Feature: Server (owner-scoped, encrypted SSH keys)
 *
 * Follows the owner-scoped shape of the generated PostController, with
 * three additions because servers hold credentials:
 *
 *   - ssh_key is encrypted with CryptoService before it is stored and is
 *     NEVER returned to the client (responses carry has_ssh_key instead)
 *   - a server owned by someone else answers 404, not 403, so the API never
 *     confirms that another user's server id exists
 *   - changing host / port / user / key resets status to "pending", because
 *     the connection has not been tested with the new details
 *
 * All routes sit behind requireAuth ("auth": true in feature.json), so
 * req.user.userId is always present here.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Server } from "../models/Server.js";
import { Provision } from "../models/Provision.js";
import { DbUser } from "../models/DbUser.js";
import { ServerDatabase } from "../models/ServerDatabase.js";
import { validateServer, normalizeServer } from "../validators/ServerValidator.js";
import { CryptoService } from "../services/CryptoService.js";
import { ServerSshKey } from "../models/ServerSshKey.js";
import { ServerWorker } from "../models/ServerWorker.js";

interface ServerRow {
    id: number;
    user_id: number;
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

/** Strips the encrypted key from anything that leaves the API. */
function toPublic(row: ServerRow) {
    const { ssh_key, ...rest } = row;
    return { ...rest, has_ssh_key: Boolean(ssh_key) };
}

/** Loads a server and answers 404 itself if it is missing or not the caller's. */
async function findOwned(req: TylixRequest, res: TylixResponse): Promise<ServerRow | null> {
    const server = (await Server.find(req.params.id)) as ServerRow | null;

    if (!server || server.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Server not found." });
        return null;
    }

    return server;
}

async function isDuplicate(
    userId: unknown,
    host: string,
    port: number,
    exceptId?: number,
): Promise<boolean> {
    // TODO: swap for a WHERE query once confirmed in the ORM; all() + filter
    // mirrors the generated PostController and is fine for small tables.
    const servers = (await Server.all()) as ServerRow[];
    return servers.some(
        (s) =>
            s.user_id === userId &&
            s.host === host &&
            Number(s.port) === port &&
            s.id !== exceptId,
    );
}

export class ServerController {
    async index(req: TylixRequest, res: TylixResponse) {
        const servers = (await Server.all()) as ServerRow[];
        const own = servers
            .filter((s) => s.user_id === req.user?.userId)
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return res.json(own.map(toPublic));
    }

    async show(req: TylixRequest, res: TylixResponse) {
        const server = await findOwned(req, res);
        if (!server) return;

        return res.json(toPublic(server));
    }

    async store(req: TylixRequest, res: TylixResponse) {
        const result = validateServer(req.body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeServer(req.body);

        if (await isDuplicate(req.user?.userId, input.host, input.port)) {
            res.status(409);
            return res.json({ error: "You've already added a server with that host and port." });
        }

        const server = (await Server.create({
            name: input.name,
            host: input.host,
            port: input.port,
            ssh_user: input.ssh_user,
            ssh_key: CryptoService.encrypt(input.ssh_key),
            status: "pending",
            user_id: req.user?.userId,
        })) as ServerRow | null;

        if (!server) {
            res.status(500);
            return res.json({ error: "Could not save the server." });
        }

        res.status(201);
        return res.json(toPublic(server));
    }

    async update(req: TylixRequest, res: TylixResponse) {
        const server = await findOwned(req, res);
        if (!server) return;

        const result = validateServer(req.body, { isUpdate: true });
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeServer(req.body);

        if (await isDuplicate(req.user?.userId, input.host, input.port, server.id)) {
            res.status(409);
            return res.json({ error: "You've already added a server with that host and port." });
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

        // ASSUMPTION: Model exposes update(id, data), same as the generated
        // PostController. Re-read the row so we never depend on its return value.
        await Server.update(server.id, patch);
        const fresh = (await Server.find(server.id)) as ServerRow | null;

        if (!fresh) {
            res.status(500);
            return res.json({ error: "Could not reload the server after saving." });
        }

        return res.json(toPublic(fresh));
    }

    async destroy(req: TylixRequest, res: TylixResponse) {
        const server = await findOwned(req, res);
        if (!server) return;

        const provisions = (await Provision.all()) as { server_id: number; status: string }[];
        if (provisions.some((p) => Number(p.server_id) === server.id && p.status !== "deleted")) {
            res.status(409);
            return res.json({
                error: "This server was created by the deployer. Delete it from the Provisioned servers list so it is removed at Linode too.",
            });
        }

                // The machine's databases go with it; drop our records so nothing is orphaned.
        for (const d of (await ServerDatabase.all()) as { id: number; server_id: number }[]) {
            if (d.server_id === server.id) await ServerDatabase.delete(d.id);
        }
        for (const u of (await DbUser.all()) as { id: number; server_id: number }[]) {
            if (u.server_id === server.id) await DbUser.delete(u.id);
        }

        for (const k of (await ServerSshKey.all()) as { id: number; server_id: number }[]) {
        if (k.server_id === server.id) await ServerSshKey.delete(k.id);
        }

        for (const w of (await ServerWorker.all()) as { id: number; server_id: number }[]) {
        if (w.server_id === server.id) await ServerWorker.delete(w.id);
        }
    
        // TODO (step 1.4c): refuse to delete while projects are attached.
        // ASSUMPTION: Model exposes delete(id).
        await Server.delete(server.id);
        res.status(204);
        return res.end();
    }
}