/**
 * Server settings routes. Team-scoped (a server on another team answers 404).
 * Any member can read; every change needs the admin role (checked again in the
 * controller) and answers 402 while the team is view only (withBillingLock).
 *
 * GET  /api/servers/:id/settings
 * GET  /api/servers/:id/system
 * GET  /api/servers/:id/delete-check
 * POST /api/servers/:id/test
 * POST /api/servers/:id/key/rotate
 * PUT  /api/servers/:id/system/timezone
 * PUT  /api/servers/:id/system/hostname
 * PUT  /api/servers/:id/system/updates
 * POST /api/servers/:id/services/:service/restart
 * POST /api/servers/:id/reboot
 */

import type { Router } from "@tylix/core";
import { ServerSettingsController } from "../controllers/ServerSettingsController.js";
import { requireRole } from "../services/TeamScope.js";
import { withBillingLock } from "../services/BillingLock.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new ServerSettingsController();

export async function routes(router: Router, { auth: baseAuth }: { auth: (handler: Handler) => Handler }) {
    const auth = withBillingLock(baseAuth);

    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get("/api/servers/:id/settings", auth(async (req, res) => { await controller.show(req, res); }));
    router.get("/api/servers/:id/system", auth(async (req, res) => { await controller.system(req, res); }));
    router.get("/api/servers/:id/delete-check", auth(async (req, res) => { await controller.deleteCheck(req, res); }));

    router.post("/api/servers/:id/test", write(async (req, res) => { await controller.test(req, res); }));
    router.post("/api/servers/:id/key/rotate", write(async (req, res) => { await controller.rotateKey(req, res); }));
    router.put("/api/servers/:id/system/timezone", write(async (req, res) => { await controller.timezone(req, res); }));
    router.put("/api/servers/:id/system/hostname", write(async (req, res) => { await controller.hostname(req, res); }));
    router.put("/api/servers/:id/system/updates", write(async (req, res) => { await controller.updates(req, res); }));
    router.post("/api/servers/:id/services/:service/restart", write(async (req, res) => { await controller.restart(req, res); }));
    router.post("/api/servers/:id/reboot", write(async (req, res) => { await controller.reboot(req, res); }));
}
