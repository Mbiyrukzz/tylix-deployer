/**
 * POST /api/sites/:id/terminal     signed one-time ticket for a site terminal
 * POST /api/servers/:id/terminal   signed one-time ticket for a server terminal
 *
 * A terminal is a shell on the machine, so both need the admin role. The
 * server controller checks team and role itself (404 for another team's
 * server before 403); the site route is wrapped here.
 */

import type { Router } from "@tylix/core";
import { SiteTerminalController } from "../controllers/SiteTerminalController.js";
import { ServerTerminalController } from "../controllers/ServerTerminalController.js";
import { requireRole } from "../services/TeamScope.js";

type Handler = Parameters<Router["post"]>[1];

const siteController = new SiteTerminalController();
const serverController = new ServerTerminalController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.post(
        "/api/sites/:id/terminal",
        write(async (req, res) => {
            await siteController.ticket(req, res);
        }),
    );

    router.post(
        "/api/servers/:id/terminal",
        auth(async (req, res) => {
            await serverController.ticket(req, res);
        }),
    );
}