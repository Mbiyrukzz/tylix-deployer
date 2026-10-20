/**
 * Feature: ServerTask (hand-written, replaces the generated CRUD controller)
 *
 * Tasks are created only by POST /api/servers/:id/packages and updated only by
 * the InstallPackages job. Here they are read-only and visible to the team
 * that owns the task's server (a task has no team_id of its own, so the
 * server decides). Anything on another team answers 404, not 403.
 *
 * Do not re-run `make:feature ServerTask`: it would overwrite this file.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { ServerTask } from "../models/ServerTask.js";
import { Server } from "../models/Server.js";
import { requireTeam } from "../services/TeamScope.js";

interface TaskRow {
    id: number;
    user_id: number;
    server_id: number;
    packages: string;
    step: string;
    status: string;
    error: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

export class ServerTaskController {
    async index(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;

        const servers = (await Server.all()) as { id: number; team_id: number | null }[];
        const ids = new Set(servers.filter((s) => Number(s.team_id) === teamId).map((s) => Number(s.id)));

        const rows = (await ServerTask.all()) as TaskRow[];
        const own = rows.filter((t) => ids.has(Number(t.server_id))).sort((a, b) => b.id - a.id);
        return res.json(own);
    }

    async show(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;

        const row = (await ServerTask.find(req.params.id)) as TaskRow | null;
        const server = row
            ? ((await Server.find(row.server_id)) as { team_id: number | null } | null)
            : null;

        if (!row || !server || Number(server.team_id) !== teamId) {
            res.status(404);
            return res.json({ error: "Task not found." });
        }

        return res.json(row);
    }

    async store(_req: TylixRequest, res: TylixResponse) {
        res.status(405);
        return res.json({ error: "Tasks are created by installing packages on a server." });
    }

    async update(_req: TylixRequest, res: TylixResponse) {
        res.status(405);
        return res.json({ error: "Tasks can't be edited." });
    }

    async destroy(_req: TylixRequest, res: TylixResponse) {
        res.status(405);
        return res.json({ error: "Tasks can't be deleted." });
    }
}
