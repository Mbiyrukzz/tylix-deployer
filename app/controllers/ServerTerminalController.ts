/**
 * POST /api/servers/:id/terminal   body { cols, rows, code? }
 *
 * Team-scoped and admin only (a server on another team answers 404; a plain
 * member answers 403). Returns a signed 30-second ticket; the shell itself
 * is opened by the "terminal" channel (services/Terminal.ts) when the
 * browser presents that ticket.
 *
 * A shell is as powerful as the root password, so it gets the same gates:
 *   - rate limited per user
 *   - two-factor: when the caller has authenticator or SMS two-factor on, a
 *     valid code (body.code) is required. Wrong codes are counted and lock
 *     the user out (requireStepUp). It runs last, after every check that can
 *     refuse the request, so a refused request never spends a code.
 *   - every ticket issued is written to the server log
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Server } from "../models/Server.js";
import { signTicket } from "../services/TerminalTicket.js";
import { ServerLogService } from "../services/ServerLogService.js";
import { createGuard, requireStepUp } from "../services/RouteGuard.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { requireActive } from "../services/EntitlementService.js";

interface ServerRow {
    id: number;
    user_id: number;
    team_id: number | null;
    [key: string]: unknown;
}

const terminalGuard = createGuard({ max: 20, windowMs: 60_000, scope: "user", what: "terminal requests" });

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export class ServerTerminalController {
    async ticket(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;
        if (!terminalGuard(req, res)) return;
        if (!(await requireActive(res, teamId))) return;

        const server = (await Server.find(req.params.id)) as ServerRow | null;

        if (!server || Number(server.team_id) !== teamId) {
            res.status(404);
            return res.json({ error: "Server not found." });
        }

        if (!requireRole(req, res, "admin")) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const cols = clamp(body.cols, 20, 300, 100);
        const rows = clamp(body.rows, 5, 100, 28);

        // Signed before the second factor, so a misconfigured terminal (503)
        // never spends a code.
        let ticket: string;
        try {
            ticket = signTicket(Number(req.user?.userId), 0, cols, rows, server.id);
        } catch {
            res.status(503);
            return res.json({ error: "The terminal isn't configured. Set TERMINAL_SECRET in the deployer's .env." });
        }

        // Last gate before the shell: second factor, if the caller has one on.
        if (!(await requireStepUp(req, res, "open a terminal on this server"))) return;

        await ServerLogService.record({
            userId: Number(req.user?.userId),
            teamId,
            serverId: server.id,
            event: "server.terminal_opened",
            message: "A terminal was opened.",
        });

        return res.json({ ticket, url: process.env.TERMINAL_URL ?? "" });
    }
}