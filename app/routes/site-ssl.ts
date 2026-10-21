/**
 * SSL routes for a site. Team-scoped (the site's server must be on the
 * caller's team; anything else answers 404). Any member can see the state
 * and expiry; enabling, installing a custom certificate and disabling all
 * change what the machine serves, so they need the admin role.
 * Writes answer 402 while the team is view only (withBillingLock).
 *
 * GET  /api/sites/:id/ssl            any member: current state, expiry and log
 * POST /api/sites/:id/ssl            admin: enable Let's Encrypt or install a custom certificate
 * POST /api/sites/:id/ssl/disable    admin: switch back to HTTP only
 */

import type { Router } from "@tylix/core";
import { SiteSslController } from "../controllers/SiteSslController.js";
import { requireRole } from "../services/TeamScope.js";
import { withBillingLock } from "../services/BillingLock.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteSslController();

export async function routes(router: Router, { auth: baseAuth }: { auth: (handler: Handler) => Handler }) {
    const auth = withBillingLock(baseAuth);

    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get(
        "/api/sites/:id/ssl",
        auth(async (req, res) => {
            await controller.show(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/ssl",
        write(async (req, res) => {
            await controller.enable(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/ssl/disable",
        write(async (req, res) => {
            await controller.disable(req, res);
        }),
    );
}