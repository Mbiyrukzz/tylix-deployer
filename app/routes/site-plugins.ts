/**
 * Plugin routes for a site. Team-scoped (the site's server must be on the
 * caller's team; anything else answers 404). Any member can see which
 * plugins are available and their status; installing and removing one runs
 * commands on the machine, so it needs the admin role.
 * Writes answer 402 while the team is view only (withBillingLock).
 *
 * GET    /api/sites/:id/plugins            any member: plugins available for this site, with status and log
 * POST   /api/sites/:id/plugins            admin: install one   body { plugin, code? }
 * DELETE /api/sites/:id/plugins/:plugin    admin: remove one    query { code? }
 *
 * Install and remove have the same gates as the site terminal, in this order:
 *   team, rate limit per user, plan active, site lookup (404), admin role (403),
 *   plugin exists and fits the site type (422), site ready and no conflicting
 *   change (409/404, via preflight), then two-factor: with authenticator or
 *   SMS two-factor on, a valid code (body.code, or ?code= on DELETE) is
 *   required. Wrong codes are counted and lock the user out (requireStepUp).
 *   Two-factor runs last, after every check that can refuse the request, so a
 *   refused request never spends a code. Every accepted request is written to
 *   the server log.
 */

import type { Router } from "@tylix/core";
import { SitePluginController, preflight } from "../controllers/SitePluginController.js";
import { Site } from "../models/Site.js";
import { getPlugin } from "../services/SitePlugins.js";
import { createGuard, audit, requireStepUp } from "../services/RouteGuard.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { requireActive } from "../services/EntitlementService.js";
import { withBillingLock } from "../services/BillingLock.js";

type Handler = Parameters<Router["post"]>[1];
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

interface SiteRow {
    id: number;
    team_id: number | null;
    server_id: number;
    type: string;
    domain: string;
    status: string;
    [key: string]: unknown;
}

const controller = new SitePluginController();

const PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const pluginGuard = createGuard({ max: 10, windowMs: 15 * 60_000, scope: "user", what: "plugin changes" });

export async function routes(router: Router, { auth: baseAuth }: { auth: (handler: Handler) => Handler }) {
    const auth = withBillingLock(baseAuth);

    /**
     * Runs every gate for install and uninstall. Returns true when the
     * request may go on to the controller; otherwise it has already answered.
     */
    async function gate(req: Req, res: Res, pluginId: unknown, action: "install" | "uninstall"): Promise<boolean> {
        const r = req as any;
        const s = res as any;

        const teamId = requireTeam(r, s);
        if (!teamId) return false;
        if (!pluginGuard(r, s)) return false;
        if (!(await requireActive(s, teamId))) return false;

        const site = (await Site.find(r.params.id)) as SiteRow | null;
        if (!site || Number(site.team_id) !== teamId) {
            s.status(404);
            s.json({ error: "Site not found." });
            return false;
        }

        if (!requireRole(r, s, "admin")) return false;

        const id = typeof pluginId === "string" ? pluginId : "";
        const def = PLUGIN_ID.test(id) ? getPlugin(id) : undefined;

        if (!def) {
            s.status(422);
            s.json({ error: "Unknown plugin.", errors: { plugin: ["Choose a valid plugin."] } });
            return false;
        }

        if (!def.types.includes(site.type)) {
            s.status(422);
            s.json({ error: `${def.name} isn't available for this site type.`, errors: { plugin: ["Not available for this site type."] } });
            return false;
        }

        if (site.status !== "ready") {
            s.status(409);
            s.json({ error: "The site isn't ready yet. Wait for it to finish creating." });
            return false;
        }

        // Every state check the controller would make, before a code is spent.
        const refusal = await preflight(site, def, action);
        if (refusal) {
            s.status(refusal.status);
            s.json({ error: refusal.error });
            return false;
        }

        // Last gate before the commands run: second factor, if the caller has one on.
        if (!(await requireStepUp(r, s, `${action} a plugin on this site`))) return false;

        await audit({
            userId: Number(r.user?.userId),
            teamId,
            serverId: site.server_id,
            event: action === "install" ? "site.plugin_install_started" : "site.plugin_remove_started",
            level: "warning",
            message: `${action === "install" ? "Installing" : "Removing"} the ${def.name} plugin on ${site.domain}.`,
            meta: { site_id: site.id, plugin: def.id },
        });

        return true;
    }

    router.get(
        "/api/sites/:id/plugins",
        auth(async (req, res) => {
            await controller.index(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/plugins",
        auth(async (req, res) => {
            const body = (req.body ?? {}) as { plugin?: unknown };
            if (!(await gate(req, res, body.plugin, "install"))) return;
            await controller.install(req, res);
        }),
    );

    router.delete(
        "/api/sites/:id/plugins/:plugin",
        auth(async (req, res) => {
            if (!(await gate(req, res, (req as any).params.plugin, "uninstall"))) return;
            await controller.uninstall(req, res);
        }),
    );
}