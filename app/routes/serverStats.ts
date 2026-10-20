/**
 * GET  /api/servers/:id/stats          one-off reading (also the fallback when
 *                                      the channel is unreachable)
 * POST /api/servers/:id/stats-ticket   signed 30-second ticket for the
 *                                      "serverstats" channel (live updates)
 *
 * Any member of the server's team may use both; another team's server answers
 * 404. The GET answers 502 when the server can't be reached.
 */

import type { Router } from "@tylix/core";
import { Server } from "../models/Server.js";
import { readStats } from "../services/ServerStats.js";
import type { StatsServer } from "../services/ServerStats.js";
import { signStatsTicket } from "../services/StatsTicket.js";
import { requireTeam } from "../services/TeamScope.js";

type Handler = Parameters<Router["get"]>[1];

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/servers/:id/stats",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const server = (await Server.find(req.params.id)) as StatsServer | null;

            if (!server || Number(server.team_id) !== teamId) {
                res.status(404);
                return res.json({ error: "Server not found." });
            }

            const result = await readStats(server);

            if (!result.ok) {
                res.status(502);
                return res.json({ error: result.error });
            }

            return res.json({ ...result.stats, status: "online" });
        }),
    );

    router.post(
        "/api/servers/:id/stats-ticket",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const server = (await Server.find(req.params.id)) as StatsServer | null;

            if (!server || Number(server.team_id) !== teamId) {
                res.status(404);
                return res.json({ error: "Server not found." });
            }

            let ticket: string;
            try {
                ticket = signStatsTicket(Number((req as any).user?.userId), server.id);
            } catch {
                res.status(503);
                return res.json({ error: "Live stats aren't configured. Set TERMINAL_SECRET in the deployer's .env." });
            }

            // TERMINAL_URL points at the terminal channel (e.g. wss://deploy.example.com/channels/terminal);
            // the stats channel sits next to it. Empty in development.
            const base = process.env.TERMINAL_URL ?? "";
            const url = base ? base.replace(/\/terminal\/?$/, "/serverstats") : "";

            return res.json({ ticket, url });
        }),
    );
}