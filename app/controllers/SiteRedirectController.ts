/**
 * Feature: Site redirects (team-scoped)
 *
 * A site that isn't on the caller's team answers 404, never 403. Any team
 * member can see the redirects; adding and removing need the admin role.
 * Redirects can only be managed once the site is "ready" (the nginx config
 * doesn't exist before). Every change is tested with nginx -t and rolled
 * back by SiteRedirects if nginx rejects it.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { ServerLogService } from "../services/ServerLogService.js";
import {
    SiteRedirects,
    RedirectError,
    RedirectRejected,
    MAX_REDIRECTS,
} from "../services/SiteRedirects.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { requireActive } from "../services/EntitlementService.js";

interface SiteRow {
    id: number;
    user_id: number;
    team_id: number | null;
    server_id: number;
    domain: string;
    isolated_user: string;
    status: string;
    [key: string]: unknown;
}

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

function notReady(res: TylixResponse) {
    res.status(409);
    return res.json({ error: "Redirects are available once the site has finished creating." });
}

function fail(res: TylixResponse, err: unknown, fallback: string) {
    if (err instanceof RedirectError) {
        res.status(err.status);
        return res.json({ error: err.message });
    }

    if (err instanceof RedirectRejected) {
        res.status(422);
        return res.json({ error: err.message || "nginx rejected the redirects." });
    }

    res.status(502);
    return res.json({ error: err instanceof Error ? err.message : fallback });
}

const toPublic = (rules: { id: string; match: string; from: string; to: string; code: number }[]) => ({
    redirects: rules,
    limit: MAX_REDIRECTS,
});

export class SiteRedirectController {
    /** GET /api/sites/:id/redirects */
    async index(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;
        if (site.status !== "ready") return notReady(res);

        try {
            return res.json(toPublic(await SiteRedirects.list(site)));
        } catch (err) {
            return fail(res, err, "Couldn't read the redirects.");
        }
    }

    /** POST /api/sites/:id/redirects   body { from, to, code, match } */
    async store(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;
        if (site.status !== "ready") return notReady(res);

        const actor = Number(req.user?.userId);
        const teamId = Number(site.team_id);

        try {
            const { rules, rule } = await SiteRedirects.add(site, req.body);

            await ServerLogService.record({
                userId: actor,
                teamId,
                serverId: site.server_id,
                event: "site.redirect_added",
                level: "success",
                message: `Redirect added on ${site.domain}: ${rule.from} to ${rule.to} (${rule.code}).`,
                meta: { site_id: site.id, match: rule.match },
            });

            res.status(201);
            return res.json(toPublic(rules));
        } catch (err) {
            if (err instanceof RedirectRejected) {
                await ServerLogService.record({
                    userId: actor,
                    teamId,
                    serverId: site.server_id,
                    event: "site.redirect_rejected",
                    level: "warning",
                    message: `A redirect for ${site.domain} was rejected by nginx and rolled back.`,
                });
            }
            return fail(res, err, "Couldn't save the redirect.");
        }
    }

    /** DELETE /api/sites/:id/redirects/:redirectId */
    async destroy(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;
        if (site.status !== "ready") return notReady(res);

        const id = String(req.params.redirectId ?? "");
        if (!/^[a-f0-9]{12}$/.test(id)) {
            res.status(404);
            return res.json({ error: "That redirect no longer exists." });
        }

        try {
            const { rules, rule } = await SiteRedirects.remove(site, id);

            await ServerLogService.record({
                userId: Number(req.user?.userId),
                teamId: Number(site.team_id),
                serverId: site.server_id,
                event: "site.redirect_removed",
                message: `Redirect removed on ${site.domain}: ${rule.from}.`,
                meta: { site_id: site.id, match: rule.match },
            });

            return res.json(toPublic(rules));
        } catch (err) {
            return fail(res, err, "Couldn't remove the redirect.");
        }
    }
}