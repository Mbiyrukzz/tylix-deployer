/**
 * Deployment routes for a site. Team-scoped (the site's server must be on
 * the caller's team; anything else answers 404). Any member can see the
 * deployment history; everything else needs the admin role, because the
 * script runs on the machine, the env holds secrets and logs can echo them.
 * Writes answer 402 while the team is view only (withBillingLock).
 *
 * GET  /api/sites/:id/deployment                   admin: script, env, status and log
 * PUT  /api/sites/:id/deployment                   admin: save script and/or env
 * POST /api/sites/:id/deploy                       admin: start a deployment
 * GET  /api/sites/:id/deployments                  any member: deployment history (no logs)
 * GET  /api/sites/:id/deployments/:deploymentId    admin: one deployment's log
 */

import type { Router } from "@tylix/core";
import { SiteController } from "../controllers/SiteController.js";
import { requireRole } from "../services/TeamScope.js";
import { withBillingLock } from "../services/BillingLock.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteController();

export async function routes(router: Router, { auth: baseAuth }: { auth: (handler: Handler) => Handler }) {
    const auth = withBillingLock(baseAuth);

    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get(
        "/api/sites/:id/deployment",
        write(async (req, res) => {
            await controller.deployment(req, res);
        }),
    );

    router.put(
        "/api/sites/:id/deployment",
        write(async (req, res) => {
            await controller.saveDeployment(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/deploy",
        write(async (req, res) => {
            await controller.deploy(req, res);
        }),
    );

    router.get(
        "/api/sites/:id/deployments",
        auth(async (req, res) => {
            await controller.deployments(req, res);
        }),
    );

    router.get(
        "/api/sites/:id/deployments/:deploymentId",
        write(async (req, res) => {
            await controller.deploymentLog(req, res);
        }),
    );
}