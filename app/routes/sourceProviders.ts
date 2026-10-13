/**
 * Source control connections (GitHub / GitLab).
 *
 * GET    /api/source-providers
 * POST   /api/source-providers
 * GET    /api/source-providers/:id
 * PUT    /api/source-providers/:id
 * DELETE /api/source-providers/:id
 *
 * All logic (owner checks, token verification and encryption, never returning
 * the token) lives in SourceProviderController.
 */

import type { Router } from "@tylix/core";
import { SourceProviderController } from "../controllers/SourceProviderController.js";

type Handler = Parameters<Router["post"]>[1];

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    const controller = new SourceProviderController();

    router.get("/api/source-providers", auth((req, res) => controller.index(req, res)));
    router.post("/api/source-providers", auth((req, res) => controller.store(req, res)));
    router.get("/api/source-providers/:id", auth((req, res) => controller.show(req, res)));
    router.put("/api/source-providers/:id", auth((req, res) => controller.update(req, res)));
    router.delete("/api/source-providers/:id", auth((req, res) => controller.destroy(req, res)));
}
