/**
 * Command routes for a site. Team-scoped (the site's server must be on the
 * caller's team; anything else answers 404). Running a command and reading
 * past runs both need the admin role, because commands run on the machine
 * and their output can contain secrets. Running answers 402 while the team
 * is view only (withBillingLock).
 *
 * GET  /api/sites/:id/commands    admin: recent runs with output (newest first)
 * POST /api/sites/:id/commands    admin: run one   body { command, directory? }
 */

import type { Router } from "@tylix/core";
import { SiteCommandController } from "../controllers/SiteCommandController.js";
import { requireRole } from "../services/TeamScope.js";
import { withBillingLock } from "../services/BillingLock.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteCommandController();

export async function routes(router: Router, { auth: baseAuth }: { auth: (handler: Handler) => Handler }) {
    const auth = withBillingLock(baseAuth);

    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get(
        "/api/sites/:id/commands",
        write(async (req, res) => {
            await controller.index(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/commands",
        write(async (req, res) => {
            await controller.run(req, res);
        }),
    );
}