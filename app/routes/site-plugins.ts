/**
 * Plugin routes for a site.
 *
 * GET    /api/sites/:id/plugins            plugins available for this site, with status and log
 * POST   /api/sites/:id/plugins            install one   body { plugin }
 * DELETE /api/sites/:id/plugins/:plugin    remove one
 */

import type { Router } from "@tylix/core";
import { SitePluginController } from "../controllers/SitePluginController.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SitePluginController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/sites/:id/plugins",
        auth(async (req, res) => {
            await controller.index(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/plugins",
        auth(async (req, res) => {
            await controller.install(req, res);
        }),
    );

    router.delete(
        "/api/sites/:id/plugins/:plugin",
        auth(async (req, res) => {
            await controller.uninstall(req, res);
        }),
    );
}