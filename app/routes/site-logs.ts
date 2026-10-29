/**
 * Log routes for a site. Team-scoped (a site on another team answers 404) and
 * admin only, because logs can contain secrets.
 *
 * GET  /api/sites/:id/logs?source=&lines=&errors=
 */

import type { Router } from "@tylix/core";
import { SiteLogController } from "../controllers/SiteLogController.js";
import { requireRole } from "../services/TeamScope.js";
import { withBillingLock } from "../services/BillingLock.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteLogController();

export async function routes(router: Router, { auth: baseAuth }: { auth: (handler: Handler) => Handler }) {
    const auth = withBillingLock(baseAuth);

    // Admin-only: a route registered with read() answers 403 to a plain member.
    // Reading stays allowed while the team is view only.
    const read = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get(
        "/api/sites/:id/logs",
        read(async (req, res) => {
            await controller.index(req, res);
        }),
    );
}