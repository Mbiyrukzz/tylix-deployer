/**
 * GET /api/servers/:id/logs?level=error&limit=100
 *
 * Any member of the server's team. Another team's server answers 404,
 * like everywhere else.
 */

import type { Router } from "@tylix/core";
import { Server } from "../models/Server.js";
import { ServerLogService } from "../services/ServerLogService.js";
import { requireTeam } from "../services/TeamScope.js";

type Handler = Parameters<Router["get"]>[1];

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/servers/:id/logs",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const server = (await Server.find(req.params.id)) as
                | { id: number; user_id: number; team_id: number | null }
                | null;

            if (!server || Number(server.team_id) !== teamId) {
                res.status(404);
                return res.json({ error: "Server not found." });
            }

            // ASSUMPTION: the request exposes parsed query params as req.query.
            const query = (req as unknown as { query?: Record<string, string> }).query ?? {};

            const logs = await ServerLogService.list(server.id, server.user_id, {
                level: typeof query.level === "string" ? query.level : "",
                category: typeof query.category === "string" ? query.category : "",
                limit: Number(query.limit),
            });
            return res.json(logs);
        }),
    );
}