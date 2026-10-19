/**
 * Command routes for a site.
 *
 * GET  /api/sites/:id/commands    recent runs with output (newest first)
 * POST /api/sites/:id/commands    run one   body { command, directory? }
 */

import type { Router } from "@tylix/core";
import { SiteCommandController } from "../controllers/SiteCommandController.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteCommandController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/sites/:id/commands",
        auth(async (req, res) => {
            await controller.index(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/commands",
        auth(async (req, res) => {
            await controller.run(req, res);
        }),
    );
}