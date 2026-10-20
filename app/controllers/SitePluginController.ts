/**
 * Feature: Site plugins (team-scoped)
 *
 * A site that isn't on the caller's team answers 404, never 403. Any team
 * member can see the plugin list; installing and removing need the admin
 * role. Installing and removing return 202 right away and the work
 * continues in the background. The page polls GET /api/sites/:id/plugins
 * for status and log.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { SitePlugin } from "../models/SitePlugin.js";
import { canDeploy, type DeployRow } from "../services/SiteDeployer.js";
import { getPlugin, pluginsFor, publicPlugin, type PluginDef } from "../services/SitePlugins.js";
import { SitePluginInstaller, portOf } from "../services/SitePluginInstaller.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";

interface SiteRow {
    id: number;
    user_id: number;
    team_id: number | null;
    server_id: number;
    type: string;
    port: number;
    status: string;
    [key: string]: unknown;
}

interface PluginRow {
    id: number;
    user_id: number;
    team_id: number | null;
    site_id: number;
    server_id: number;
    plugin: string;
    status: string;
    error: string;
    log: string;
    config: string;
    installed_at: string;
    updated_at: string;
    [key: string]: unknown;
}

const STALE_MS = 20 * 60_000;

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

async function rowsFor(siteId: number): Promise<PluginRow[]> {
    return ((await SitePlugin.all()) as PluginRow[]).filter((r) => Number(r.site_id) === siteId);
}

const isBusy = (row: PluginRow) =>
    (row.status === "installing" || row.status === "removing") &&
    Date.now() - new Date(row.updated_at).getTime() < STALE_MS;

function blockedReason(site: SiteRow, def: PluginDef): string {
    if (site.status !== "ready") return "The site has to finish creating first.";
    if (def.needsRepo && !canDeploy(site as unknown as DeployRow)) {
        return "This plugin needs a site that was created from a repository.";
    }
    return "";
}

async function freePort(serverId: number, start: number): Promise<number> {
    const used = new Set<number>();

    for (const s of (await Site.all()) as SiteRow[]) {
        if (Number(s.server_id) === serverId) used.add(Number(s.port));
    }
    for (const p of (await SitePlugin.all()) as PluginRow[]) {
        if (Number(p.server_id) === serverId) used.add(portOf(p));
    }

    let port = start;
    while (used.has(port)) port++;
    return port;
}

export class SitePluginController {
    /** GET /api/sites/:id/plugins */
    async index(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;

        const rows = await rowsFor(site.id);
        const byId = new Map(rows.map((r) => [r.plugin, r]));

        return res.json(
            pluginsFor(site.type).map((def) => {
                const row = byId.get(def.id);
                return {
                    ...publicPlugin(def),
                    status: row?.status ?? "available",
                    error: String(row?.error ?? ""),
                    log: String(row?.log ?? ""),
                    installed_at: String(row?.installed_at ?? ""),
                    port: portOf(row),
                    blocked: blockedReason(site, def),
                };
            }),
        );
    }

    /** POST /api/sites/:id/plugins   body { plugin } */
    async install(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;

        const id = String(((req.body ?? {}) as Record<string, unknown>).plugin ?? "");
        const def = getPlugin(id);

        if (!def || !def.types.includes(site.type)) {
            res.status(422);
            return res.json({ error: "That plugin isn't available for this kind of site." });
        }

        const blocked = blockedReason(site, def);
        if (blocked) {
            res.status(409);
            return res.json({ error: blocked });
        }

        const rows = await rowsFor(site.id);
        if (rows.some(isBusy)) {
            res.status(409);
            return res.json({ error: "Another plugin change is still running on this site. Wait for it to finish." });
        }

        const existing = rows.find((r) => r.plugin === def.id);
        if (existing && existing.status === "installed") {
            res.status(409);
            return res.json({ error: `${def.name} is already installed.` });
        }

        const port = def.port ? portOf(existing) || (await freePort(site.server_id, def.port.start)) : 0;

        const data = {
            user_id: req.user?.userId,
            team_id: Number(site.team_id),
            site_id: site.id,
            server_id: site.server_id,
            plugin: def.id,
            status: "installing",
            step: "install",
            error: "",
            log: "",
            config: JSON.stringify({ port }),
            installed_at: "",
        };

        if (existing) await SitePlugin.update(existing.id, data);
        else await SitePlugin.create(data);

        SitePluginInstaller.start(site.id, def.id, "install");

        res.status(202);
        return res.json({ status: "installing" });
    }

    /** DELETE /api/sites/:id/plugins/:plugin */
    async uninstall(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;

        const def = getPlugin(String(req.params.plugin ?? ""));
        const rows = await rowsFor(site.id);
        const row = def ? rows.find((r) => r.plugin === def.id) : undefined;

        if (!def || !row) {
            res.status(404);
            return res.json({ error: "That plugin isn't installed on this site." });
        }

        if (rows.some(isBusy)) {
            res.status(409);
            return res.json({ error: "Another plugin change is still running on this site. Wait for it to finish." });
        }

        await SitePlugin.update(row.id, { status: "removing", step: "uninstall", error: "" });
        SitePluginInstaller.start(site.id, def.id, "uninstall");

        res.status(202);
        return res.json({ status: "removing" });
    }
}