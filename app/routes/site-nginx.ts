/**
 * nginx config routes for a site. Team-scoped (the site's server must be on
 * the caller's team; anything else answers 404). Any member can read the
 * config; saving it needs the admin role, because it changes what the
 * machine serves. Saving answers 402 while the team is view only (withBillingLock).
 *
 * GET /api/sites/:id/nginx    any member: the site's nginx config
 * PUT /api/sites/:id/nginx    admin: save it (nginx -t first, rolled back on failure)
 */

import type { Router } from "@tylix/core";
import { SiteNginxController } from "../controllers/SiteNginxController.js";
import { requireRole } from "../services/TeamScope.js";
import { withBillingLock } from "../services/BillingLock.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteNginxController();

export async function routes(router: Router, { auth: baseAuth }: { auth: (handler: Handler) => Handler }) {
    const auth = withBillingLock(baseAuth);

    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get(
        "/api/sites/:id/nginx",
        auth(async (req, res) => {
            await controller.show(req, res);
        }),
    );

    router.put(
        "/api/sites/:id/nginx",
        write(async (req, res) => {
            await controller.save(req, res);
        }),
    );
}