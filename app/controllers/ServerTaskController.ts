/**
 * Feature: ServerTask (hand-written, replaces the generated CRUD controller)
 *
 * Tasks are created only by POST /api/servers/:id/packages and updated only by
 * the InstallPackages job. Here they are read-only and visible to their owner.
 * Someone else's task answers 404, not 403.
 *
 * Do not re-run `make:feature ServerTask`: it would overwrite this file.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { ServerTask } from "../models/ServerTask.js";

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
        const rows = (await ServerTask.all()) as TaskRow[];
        const own = rows.filter((t) => t.user_id === req.user?.userId).sort((a, b) => b.id - a.id);
        return res.json(own);
    }

    async show(req: TylixRequest, res: TylixResponse) {
        const row = (await ServerTask.find(req.params.id)) as TaskRow | null;

        if (!row || row.user_id !== req.user?.userId) {
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
