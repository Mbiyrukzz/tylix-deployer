/**
 * POST /api/sites/:id/terminal     signed one-time ticket for a site terminal
 * POST /api/servers/:id/terminal   signed one-time ticket for a server terminal
 */

import type { Router } from "@tylix/core";
import { SiteTerminalController } from "../controllers/SiteTerminalController.js";
import { ServerTerminalController } from "../controllers/ServerTerminalController.js";

type Handler = Parameters<Router["post"]>[1];

const siteController = new SiteTerminalController();
const serverController = new ServerTerminalController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.post(
        "/api/sites/:id/terminal",
        auth(async (req, res) => {
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