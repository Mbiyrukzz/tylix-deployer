/**
 * POST /api/sites/:id/terminal   signed one-time ticket for the web terminal
 */

import type { Router } from "@tylix/core";
import { SiteTerminalController } from "../controllers/SiteTerminalController.js";

type Handler = Parameters<Router["post"]>[1];

const controller = new SiteTerminalController();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.post(
        "/api/sites/:id/terminal",
        auth(async (req, res) => {
            await controller.ticket(req, res);
        }),
    );
}