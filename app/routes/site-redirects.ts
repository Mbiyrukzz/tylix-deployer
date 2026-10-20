/**
 * Redirect routes for a site. Team-scoped (the site's server must be on the
 * caller's team; anything else answers 404). Any member can list redirects;
 * adding and removing one rewrites the site's nginx config, so it needs the
 * admin role.
 *
 * GET    /api/sites/:id/redirects                 any member: the site's redirects
 * POST   /api/sites/:id/redirects                 admin: add one   body { from, to, code, match }
 * DELETE /api/sites/:id/redirects/:redirectId     admin: remove one
 */

import type { Router } from "@tylix/core";
import { SiteRedirectController } from "../controllers/SiteRedirectController.js";
import { requireRole } from "../services/TeamScope.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteRedirectController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get(
        "/api/sites/:id/redirects",
        auth(async (req, res) => {
            await controller.index(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/redirects",
        write(async (req, res) => {
            await controller.store(req, res);
        }),
    );

    router.delete(
        "/api/sites/:id/redirects/:redirectId",
        write(async (req, res) => {
            await controller.destroy(req, res);
        }),
    );
}