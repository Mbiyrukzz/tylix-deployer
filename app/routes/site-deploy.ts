/**
 * Deployment routes for a site.
 *
 * GET  /api/sites/:id/deployment   script, env, status and log
 * PUT  /api/sites/:id/deployment   save script and/or env
 * POST /api/sites/:id/deploy       start a deployment
 * GET  /api/sites/:id/deployments                  deployment history (no logs)
 * GET  /api/sites/:id/deployments/:deploymentId    one deployment's log
 */

import type { Router } from "@tylix/core";
import { SiteController } from "../controllers/SiteController.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/sites/:id/deployment",
        auth(async (req, res) => {
            await controller.deployment(req, res);
        }),
    );

    router.put(
        "/api/sites/:id/deployment",
        auth(async (req, res) => {
            await controller.saveDeployment(req, res);
        }),
    );

    router.post(
        "/api/sites/:id/deploy",
        auth(async (req, res) => {
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
        auth(async (req, res) => {
            await controller.deploymentLog(req, res);
        }),
    );
}