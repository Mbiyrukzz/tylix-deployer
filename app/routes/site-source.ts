/**
 * The repository a site deploys from.
 *
 * PUT /api/sites/:id/source   admin
 *   { source_control_id, repository, branch, reset?, code? }   connect or change
 *   { source_control_id: 0 }                                    disconnect
 *
 * Connecting points the site's checkout at the repository and checks the
 * connection can read it (SiteSource). It decides what code runs on the
 * server, so with two-factor on it needs a code, like adding a server. When
 * the folder has no checkout or its history isn't on that branch, the answer
 * is 409 { needs_reset }: the browser asks, then sends reset: true.
 *
 * Disconnecting only stops Flux deploys; nothing on the server changes.
 * Refused while a deploy of the site is queued or running, and while the team
 * is view only. Rate limited per user and written to the server log.
 */

import type { Router } from "@tylix/core";
import { Site } from "../models/Site.js";
import { createGuard, audit, requireStepUp } from "../services/RouteGuard.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { requireActive } from "../services/EntitlementService.js";
import { getType } from "../services/SiteTypes.js";
import { SiteSource, SourceError, type SourceSite } from "../services/SiteSource.js";

type Handler = Parameters<Router["post"]>[1];

const guard = createGuard({ max: 20, windowMs: 15 * 60_000, scope: "user", what: "repository changes" });

/** One change per site at a time: two would race on the same checkout. */
const busy = new Set<number>();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.put(
        "/api/sites/:id/source",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const site = (await Site.find(req.params.id)) as (SourceSite & Record<string, unknown>) | null;
            if (!site || Number(site.team_id) !== teamId) {
                res.status(404);
                return res.json({ error: "Site not found." });
            }
            if (!requireRole(req as any, res as any, "admin")) return;
            if (!(await requireActive(res as any, teamId))) return;

            if (getType(String(site.type))?.usesRepository === false) {
                res.status(422);
                return res.json({ error: "This kind of site doesn't deploy from a repository." });
            }
            if (site.status !== "ready") {
                res.status(409);
                return res.json({ error: "The site must be ready before its repository can change." });
            }
            if (site.deploy_status === "queued" || site.deploy_status === "deploying") {
                res.status(409);
                return res.json({ error: "A deploy is queued or running. Wait for it to finish, then try again." });
            }

            const b = (req.body ?? {}) as Record<string, unknown>;
            const sourceControlId = Number(b.source_control_id) || 0;
            const userId = Number(req.user?.userId);

            // ---- disconnect ----
            if (sourceControlId === 0) {
                await Site.update(site.id, { source_control_id: 0, repository: "", branch: "" });
                await audit({
                    userId,
                    teamId,
                    serverId: Number(site.server_id),
                    event: "site.source_removed",
                    level: "info",
                    message: `Site ${site.domain} no longer deploys from ${String(site.repository || "a repository")}.`,
                    meta: { site_id: site.id },
                });
                return res.json({ source_control_id: 0, repository: "", branch: "" });
            }

            // ---- connect ----
            const repository = String(b.repository ?? "").trim();
            const branch = String(b.branch ?? "").trim() || "main";
            const reset = b.reset === true;

            if (!guard(req as any, res as any)) return;
            if (busy.has(site.id)) {
                res.status(409);
                return res.json({ error: "This site's repository is already being changed." });
            }
            if (!(await requireStepUp(req as any, res as any, "change this site's repository"))) return;

            busy.add(site.id);
            try {
                const result = await SiteSource.connect(site, { sourceControlId, repository, branch, reset });

                if (!result.ok) {
                    res.status(result.needsReset ? 409 : 502);
                    return res.json({ error: result.error, needs_reset: result.needsReset || undefined, log: result.log });
                }

                const wasConnected = Number(site.source_control_id) !== 0 && String(site.repository) !== "";
                await Site.update(site.id, {
                    source_control_id: sourceControlId,
                    repository,
                    branch,
                    install_deps: wasConnected ? site.install_deps : 1,
                });

                await audit({
                    userId,
                    teamId,
                    serverId: Number(site.server_id),
                    event: "site.source_changed",
                    level: "success",
                    message: `Site ${site.domain} now deploys from ${repository} (${branch}).`,
                    meta: { site_id: site.id, repository, branch, commit: result.commit || null, reset },
                });

                return res.json({
                    source_control_id: sourceControlId,
                    repository,
                    branch,
                    commit: result.commit,
                    message: result.message,
                    log: result.log,
                });
            } catch (error) {
                if (error instanceof SourceError) {
                    res.status(error.status);
                    return res.json({ error: error.message });
                }
                console.error("[site-source]", error);
                res.status(500);
                return res.json({ error: "Something went wrong while connecting the repository." });
            } finally {
                busy.delete(site.id);
            }
        }),
    );
}
