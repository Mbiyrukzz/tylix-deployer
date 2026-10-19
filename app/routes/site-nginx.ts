/**
 * nginx config routes for a site.
 *
 * GET /api/sites/:id/nginx    the site's nginx config
 * PUT /api/sites/:id/nginx    save it (nginx -t first, rolled back on failure)
 */

import type { Router } from "@tylix/core";
import { SiteNginxController } from "../controllers/SiteNginxController.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteNginxController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/sites/:id/nginx",
        auth(async (req, res) => {
            await controller.show(req, res);
        }),
    );

    router.put(
        "/api/sites/:id/nginx",
        auth(async (req, res) => {
            await controller.save(req, res);
        }),
    );
}