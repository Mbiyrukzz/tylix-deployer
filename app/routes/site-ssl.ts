/**
 * SSL routes for a site.
 *
 * GET  /api/sites/:id/ssl            current state, expiry and log
 * POST /api/sites/:id/ssl            enable Let's Encrypt or install a custom certificate
 * POST /api/sites/:id/ssl/disable    switch back to HTTP only
 */

import type { Router } from "@tylix/core";
import { SiteSslController } from "../controllers/SiteSslController.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteSslController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/sites/:id/ssl",
        auth(async (req, res) => {
            await controller.show(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/ssl",
        auth(async (req, res) => {
            await controller.enable(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/ssl/disable",
        auth(async (req, res) => {
            await controller.disable(req, res);
        }),
    );
}