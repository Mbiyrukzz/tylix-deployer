/**
 * Plugin routes for a site. Team-scoped (the site's server must be on the
 * caller's team; anything else answers 404). Any member can see which
 * plugins are available and their status; installing and removing one runs
 * commands on the machine, so it needs the admin role.
 *
 * GET    /api/sites/:id/plugins            any member: plugins available for this site, with status and log
 * POST   /api/sites/:id/plugins            admin: install one   body { plugin }
 * DELETE /api/sites/:id/plugins/:plugin    admin: remove one
 */

import type { Router } from "@tylix/core";
import { SitePluginController } from "../controllers/SitePluginController.js";
import { requireRole } from "../services/TeamScope.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SitePluginController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get(
        "/api/sites/:id/plugins",
        auth(async (req, res) => {
            await controller.index(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/plugins",
        write(async (req, res) => {
            await controller.install(req, res);
        }),
    );

    router.delete(
        "/api/sites/:id/plugins/:plugin",
        write(async (req, res) => {
            await controller.uninstall(req, res);
        }),
    );
}