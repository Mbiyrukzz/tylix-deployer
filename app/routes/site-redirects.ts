/**
 * Redirect routes for a site.
 *
 * GET    /api/sites/:id/redirects                 the site's redirects
 * POST   /api/sites/:id/redirects                 add one   body { from, to, code, match }
 * DELETE /api/sites/:id/redirects/:redirectId     remove one
 */

import type { Router } from "@tylix/core";
import { SiteRedirectController } from "../controllers/SiteRedirectController.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteRedirectController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/sites/:id/redirects",
        auth(async (req, res) => {
            await controller.index(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/redirects",
        auth(async (req, res) => {
            await controller.store(req, res);
        }),
    );

    router.delete(
        "/api/sites/:id/redirects/:redirectId",
        auth(async (req, res) => {
            await controller.destroy(req, res);
        }),
    );
}