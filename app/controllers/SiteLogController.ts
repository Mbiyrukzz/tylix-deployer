/**
 * Feature: Site logs (team-scoped, admin only)
 *
 * A site that isn't on the caller's team answers 404, never 403. Logs can
 * contain secrets (tokens in URLs, env values in stack traces), so reading
 * them needs the admin role, like running commands. They can only be read
 * once the site is "ready". Rate limited per user because every request is
 * an SSH call.
 *
 *   GET /api/sites/:id/logs?source=app&lines=1000&errors=1
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { SiteLogs, sourcesFor, MIN_LINES, MAX_LINES, DEFAULT_LINES, type LogSourceId } from "../services/SiteLogs.js";
import { createGuard } from "../services/RouteGuard.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";

interface SiteRow {
    id: number;
    user_id: number;
    team_id: number | null;
    server_id: number;
    type: string;
    domain: string;
    isolated_user: string;
    php_version: string;
    app_directory: string;
    status: string;
    [key: string]: unknown;
}

const logGuard = createGuard({ max: 60, windowMs: 60_000, scope: "user", what: "log requests" });

async function findOwnedSite(req: TylixRequest, res: TylixResponse): Promise<SiteRow | null> {
    const teamId = requireTeam(req, res);
    if (!teamId) return null;

    const site = (await Site.find(req.params.id)) as SiteRow | null;

    if (!site || Number(site.team_id) !== teamId) {
        res.status(404);
        res.json({ error: "Site not found." });
        return null;
    }

    return site;
}

export class SiteLogController {
    /** GET /api/sites/:id/logs */
    async index(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;
        if (!logGuard(req, res)) return;

        if (site.status !== "ready") {
            res.status(409);
            return res.json({ error: "Logs are available once the site has finished creating." });
        }

        const sources = sourcesFor(site);
        const query = (req.query ?? {}) as Record<string, unknown>;

        // An unknown or missing source falls back to the first one this site offers.
        const wanted = String(query.source ?? "");
        const source = (sources.find((s) => s.id === wanted) ?? sources[0]).id as LogSourceId;

        const n = Number(query.lines);
        const lines = Number.isInteger(n) ? Math.min(MAX_LINES, Math.max(MIN_LINES, n)) : DEFAULT_LINES;
        const errorsOnly = String(query.errors ?? "1") !== "0";

        try {
            const result = await SiteLogs.read(site, source, lines, errorsOnly);

            return res.json({
                sources,
                source,
                lines,
                errors_only: errorsOnly,
                missing: result.missing,
                scanned: result.scanned,
                entries: result.entries,
            });
        } catch (err) {
            res.status(502);
            return res.json({ error: err instanceof Error ? err.message : "Couldn't read the logs." });
        }
    }
}