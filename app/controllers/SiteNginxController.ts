/**
 * Feature: Site nginx config editor (team-scoped)
 *
 * A site that isn't on the caller's team answers 404, never 403. Any team
 * member can read the config; saving needs the admin role. The config can
 * only be read or edited once the site is "ready" (the file doesn't exist
 * before). Saving runs nginx -t and rolls back by itself if it fails (see
 * SiteNginx).
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { ServerLogService } from "../services/ServerLogService.js";
import { SiteNginx, NginxRejected, MAX_NGINX_BYTES, nginxPathFor } from "../services/SiteNginx.js";
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
    return res.json({ error: "The nginx config is available once the site has finished creating." });
}

export class SiteNginxController {
    /** GET /api/sites/:id/nginx */
    async show(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;
        if (site.status !== "ready") return notReady(res);

        try {
            const content = await SiteNginx.read(site);
            return res.json({ path: nginxPathFor(site.domain), content });
        } catch (err) {
            res.status(502);
            return res.json({ error: err instanceof Error ? err.message : "Couldn't read the nginx config." });
        }
    }

    /** PUT /api/sites/:id/nginx   body { content } */
    async save(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;
        if (site.status !== "ready") return notReady(res);

        const raw = ((req.body ?? {}) as Record<string, unknown>).content;

        if (typeof raw !== "string") {
            res.status(422);
            return res.json({ error: "The config must be text." });
        }

        let content = raw.replace(/\r\n/g, "\n");

        if (content.trim() === "") {
            res.status(422);
            return res.json({ error: "The config can't be empty." });
        }
        if (content.includes("\0")) {
            res.status(422);
            return res.json({ error: "The config contains an invalid character." });
        }
        if (Buffer.byteLength(content, "utf8") > MAX_NGINX_BYTES) {
            res.status(422);
            return res.json({ error: `The config is too long (max ${MAX_NGINX_BYTES} bytes).` });
        }

        if (!content.endsWith("\n")) content += "\n";

        const actor = Number(req.user?.userId);
        const teamId = Number(site.team_id);

        try {
            await SiteNginx.write(site, content);
        } catch (err) {
            if (err instanceof NginxRejected) {
                await ServerLogService.record({
                    userId: actor,
                    teamId,
                    serverId: site.server_id,
                    event: "site.nginx_rejected",
                    level: "warning",
                    message: `An nginx config edit for ${site.domain} was rejected and rolled back.`,
                });

                res.status(422);
                return res.json({ error: err.message || "nginx rejected the config." });
            }

            res.status(502);
            return res.json({ error: err instanceof Error ? err.message : "Couldn't save the nginx config." });
        }

        await ServerLogService.record({
            userId: actor,
            teamId,
            serverId: site.server_id,
            event: "site.nginx_updated",
            level: "success",
            message: `The nginx config for ${site.domain} was edited and nginx was reloaded.`,
        });

        return res.json({ content });
    }
}