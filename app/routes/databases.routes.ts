/**
 * Database users and databases on a server (MySQL). Team-scoped: anything on
 * another team answers 404. Any member can list; everything else (including
 * viewing a password) needs the admin role.
 *
 * GET    /api/servers/:id/databases       { users, databases } for a server
 * POST   /api/servers/:id/db-users        { name }  create a MySQL user (password is generated)
 * POST   /api/servers/:id/databases       { name, db_user_id }  create a database owned by that user
 * GET    /api/db-users/:id/password       { password }
 * POST   /api/db-users/:id/password       reset: generates and sets a new password, returns it
 * DELETE /api/db-users/:id                refused while the user still owns databases
 * DELETE /api/databases/:id               drops the database on the server
 *
 * The server is changed first and the row is saved only if that worked, so
 * the list never shows something that doesn't exist.
 */

import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { Server } from "../models/Server.js";
import { DbUser } from "../models/DbUser.js";
import { ServerDatabase } from "../models/ServerDatabase.js";
import { CryptoService } from "../services/CryptoService.js";
import { serverTarget } from "../services/Shell.js";
import { DatabaseManager, generatePassword } from "../services/DatabaseManager.js";
import {
    checkCharset,
    checkDatabaseName,
    checkDbUserName,
    COLLATIONS,
    DEFAULT_CHARSET,
    DEFAULT_COLLATION,
} from "../validators/DatabaseValidator.js";

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

interface DbUserRow {
    id: number;
    user_id: number;
    server_id: number;
    name: string;
    host: string;
    password: string;
    created_at: string;
    [key: string]: unknown;
}

interface DbRow {
    id: number;
    user_id: number;
    server_id: number;
    db_user_id: number;
    name: string;
    created_at: string;
    [key: string]: unknown;
}

const publicUser = (u: DbUserRow) => ({
    id: u.id,
    server_id: u.server_id,
    name: u.name,
    host: u.host,
    created_at: u.created_at,
});

const teamOf = (req: TylixRequest) => Number((req.user as { teamId?: unknown } | undefined)?.teamId);

async function ownedServer(req: TylixRequest, res: TylixResponse): Promise<ServerRow | null> {
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

/** A record belongs to the team of its server. If the server is gone, only its creator may clean it up. */
async function mayTouch(req: TylixRequest, serverId: number, rowUserId: number): Promise<boolean> {
    const server = (await Server.find(serverId)) as ServerRow | null;
    if (server) return Number(server.team_id) === teamOf(req);
    return rowUserId === req.user?.userId;
}

async function ownedDbUser(req: TylixRequest, res: TylixResponse): Promise<DbUserRow | null> {
    const row = (await DbUser.find(req.params.id)) as DbUserRow | null;
    if (!row || !(await mayTouch(req, row.server_id, row.user_id))) {
        res.status(404);
        res.json({ error: "Database user not found." });
        return null;
    }
    return row;
}

/** The server a row belongs to (it may have been removed since). */
async function serverFor(serverId: number, teamId: number): Promise<ServerRow | null> {
    const server = (await Server.find(serverId)) as ServerRow | null;
    return server && Number(server.team_id) === teamId ? server : null;
}

function serverGone(res: TylixResponse) {
    res.status(409);
    return res.json({ error: "The server for this record no longer exists." });
}

function sshFailed(res: TylixResponse, error: string) {
    res.status(502);
    return res.json({ error });
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res,next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    // ---- list ----------------------------------------------------------
    router.get(
        "/api/servers/:id/databases",
        auth(async (req, res) => {
            const server = await ownedServer(req, res);
            if (!server) return;

            const users = ((await DbUser.all()) as DbUserRow[])
                .filter((u) => u.server_id === server.id)
                .sort((a, b) => a.name.localeCompare(b.name));
            const dbs = ((await ServerDatabase.all()) as DbRow[])
                .filter((d) => d.server_id === server.id)
                .sort((a, b) => a.name.localeCompare(b.name));

            const names = new Map(users.map((u) => [u.id, u.name]));

            return res.json({
                users: users.map(publicUser),
                databases: dbs.map((d) => ({
                    id: d.id,
                    name: d.name,
                    db_user_id: d.db_user_id,
                    user_name: names.get(d.db_user_id) ?? "",
                    charset: String(d.charset ?? ""),
                    collation: String(d.collation ?? ""),
                    created_at: d.created_at,
                })),
            });
        }),
    );

    // ---- create user ---------------------------------------------------
    router.post(
        "/api/servers/:id/db-users",
        write(async (req, res) => {
            const server = await ownedServer(req, res);
            if (!server) return;

            const body = (req.body ?? {}) as Record<string, unknown>;
            const name = String(body.name ?? "").trim().toLowerCase();

            const problem = checkDbUserName(name);
            if (problem) {
                res.status(422);
                return res.json({ errors: { name: [problem] } });
            }

            const taken = ((await DbUser.all()) as DbUserRow[]).some(
                (u) => u.server_id === server.id && u.name === name,
            );
            if (taken) {
                res.status(422);
                return res.json({ errors: { name: ["A user with that name already exists on this server."] } });
            }

            const password = generatePassword();
            const result = await DatabaseManager.createUser(serverTarget(server), name, password);
            if (!result.ok) return sshFailed(res, result.error);

            const row = (await DbUser.create({
                user_id: req.user?.userId,
                server_id: server.id,
                name,
                host: "localhost",
                password: CryptoService.encrypt(password),
            })) as DbUserRow | null;

            if (!row) {
                // The MySQL user exists but we couldn't record it: undo, so nothing is orphaned.
                await DatabaseManager.dropUser(serverTarget(server), name);
                res.status(500);
                return res.json({ error: "Could not save the database user." });
            }

            res.status(201);
            return res.json({ ...publicUser(row), password });
        }),
    );

    // ---- show / reset password ----------------------------------------
    router.get(
        "/api/db-users/:id/password",
        write(async (req, res) => {
            const user = await ownedDbUser(req, res);
            if (!user) return;

            return res.json({ password: CryptoService.decrypt(user.password) });
        }),
    );

    router.post(
        "/api/db-users/:id/password",
        write(async (req, res) => {
            const user = await ownedDbUser(req, res);
            if (!user) return;

            const server = await serverFor(user.server_id, teamOf(req));
            if (!server) return serverGone(res);

            const password = generatePassword();
            const result = await DatabaseManager.setPassword(serverTarget(server), user.name, password);
            if (!result.ok) return sshFailed(res, result.error);

            await DbUser.update(user.id, { password: CryptoService.encrypt(password) });
            return res.json({ password });
        }),
    );

    // ---- delete user ---------------------------------------------------
    router.delete(
        "/api/db-users/:id",
        write(async (req, res) => {
            const user = await ownedDbUser(req, res);
            if (!user) return;

            const owns = ((await ServerDatabase.all()) as DbRow[]).some((d) => d.db_user_id === user.id);
            if (owns) {
                res.status(409);
                return res.json({ error: "This user still owns databases. Delete those databases first." });
            }

            const server = await serverFor(user.server_id, teamOf(req));
            if (server) {
                const result = await DatabaseManager.dropUser(serverTarget(server), user.name);
                if (!result.ok) return sshFailed(res, result.error);
            }

            await DbUser.delete(user.id);
            res.status(204);
            return res.end();
        }),
    );

    // ---- create database ----------------------------------------------
    router.post(
        "/api/servers/:id/databases",
        write(async (req, res) => {
            const server = await ownedServer(req, res);
            if (!server) return;

            const body = (req.body ?? {}) as Record<string, unknown>;
            const name = String(body.name ?? "").trim().toLowerCase();
            const ownerId = Number(body.db_user_id) || 0;
            const errors: Record<string, string[]> = {};

            const problem = checkDatabaseName(name);
            if (problem) {
                errors.name = [problem];
            } else {
                const exists = ((await ServerDatabase.all()) as DbRow[]).some(
                    (d) => d.server_id === server.id && d.name === name,
                );
                if (exists) errors.name = ["A database with that name already exists on this server."];
            }

            const charset = String(body.charset ?? "").trim().toLowerCase() || DEFAULT_CHARSET;
            const collation =
                String(body.collation ?? "").trim().toLowerCase() || (COLLATIONS[charset]?.[0] ?? DEFAULT_COLLATION);
            const charsetProblem = checkCharset(charset, collation);
            if (charsetProblem) errors.collation = [charsetProblem];

            const owner = ownerId ? ((await DbUser.find(ownerId)) as DbUserRow | null) : null;
            const ownerOk = Boolean(owner && owner.server_id === server.id);
            if (!ownerOk) errors.db_user_id = ["Choose a database user."];

            if (Object.keys(errors).length > 0) {
                res.status(422);
                return res.json({ errors });
            }

            const dbUser = owner as DbUserRow;
            const result = await DatabaseManager.createDatabase(
                serverTarget(server),
                name,
                dbUser.name,
                charset,
                collation,
            );
            if (!result.ok) return sshFailed(res, result.error);

            const row = (await ServerDatabase.create({
                user_id: req.user?.userId,
                server_id: server.id,
                db_user_id: dbUser.id,
                name,
                charset,
                collation,
            })) as DbRow | null;

            if (!row) {
                await DatabaseManager.dropDatabase(serverTarget(server), name, dbUser.name);
                res.status(500);
                return res.json({ error: "Could not save the database." });
            }

            res.status(201);
            return res.json({
                id: row.id,
                name: row.name,
                db_user_id: dbUser.id,
                user_name: dbUser.name,
                charset,
                collation,
                password: CryptoService.decrypt(dbUser.password),
            });
        }),
    );

    // ---- delete database ----------------------------------------------
    router.delete(
        "/api/databases/:id",
        write(async (req, res) => {
            const row = (await ServerDatabase.find(req.params.id)) as DbRow | null;
            if (!row || !(await mayTouch(req, row.server_id, row.user_id))) {
                res.status(404);
                return res.json({ error: "Database not found." });
            }

            const server = await serverFor(row.server_id, teamOf(req));
            if (server) {
                const owner = (await DbUser.find(row.db_user_id)) as DbUserRow | null;
                const result = await DatabaseManager.dropDatabase(serverTarget(server), row.name, owner?.name ?? null);
                if (!result.ok) return sshFailed(res, result.error);
            }

            await ServerDatabase.delete(row.id);
            res.status(204);
            return res.end();
        }),
    );
}