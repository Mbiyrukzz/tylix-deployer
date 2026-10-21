/**
 * POST /api/sites/:id/terminal   body { cols, rows }
 *
 * Team-scoped and admin only (a site on another team answers 404; a plain
 * member answers 403). Returns a signed 30-second ticket; the shell itself
 * is opened by the "terminal" channel (services/Terminal.ts) when the
 * browser presents that ticket.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { signTicket } from "../services/TerminalTicket.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { requireActive } from "../services/EntitlementService.js";

interface SiteRow {
    id: number;
    user_id: number;
    team_id: number | null;
    server_id: number;
    status: string;
    [key: string]: unknown;
}

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export class SiteTerminalController {
    async ticket(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;
        if (!(await requireActive(res, teamId))) return;

        const site = (await Site.find(req.params.id)) as SiteRow | null;

        if (!site || Number(site.team_id) !== teamId) {
            res.status(404);
            return res.json({ error: "Site not found." });
        }

        if (!requireRole(req, res, "admin")) return;

        if (site.status !== "ready") {
            res.status(409);
            return res.json({ error: "The site isn't ready yet. Wait for it to finish creating." });
        }

        const server = await Server.find(site.server_id);
        if (!server) {
            res.status(409);
            return res.json({ error: "The server no longer exists." });
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        const cols = clamp(body.cols, 20, 300, 100);
        const rows = clamp(body.rows, 5, 100, 28);

        let ticket: string;
        try {
            ticket = signTicket(Number(req.user?.userId), site.id, cols, rows);
        } catch {
            res.status(503);
            return res.json({ error: "The terminal isn't configured. Set TERMINAL_SECRET in the deployer's .env." });
        }

        // TERMINAL_URL: full ws(s) URL of the channel when it sits behind a proxy
        // (e.g. wss://deploy.example.com/channels/terminal). Empty in development.
        return res.json({ ticket, url: process.env.TERMINAL_URL ?? "" });
    }
}