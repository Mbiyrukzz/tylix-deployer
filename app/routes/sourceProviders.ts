/**
 * Source control connections (GitHub / GitLab).
 *
 * GET    /api/source-providers
 * POST   /api/source-providers
 * GET    /api/source-providers/:id
 * PUT    /api/source-providers/:id
 * DELETE /api/source-providers/:id
 * GET    /api/source-providers/:id/repositories   every repo the token can see
 * GET    /api/source-providers/:id/branches?repo=owner/name
 *
 * GET    /api/source-controls[...]   aliases used by the site form
 *
 * Connection logic lives in SourceProviderController, repo/branch listing in
 * SourceRepositoryController.
 */
import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { SourceProviderController } from "../controllers/SourceProviderController.js";
import { SourceRepositoryController } from "../controllers/SourceRepositoryController.js";

type Handler = Parameters<Router["post"]>[1];

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    const controller = new SourceProviderController();
    const repos = new SourceRepositoryController();

    // Drops the controller's return value so it matches the router's handler type.
    const run =
        (fn: (req: TylixRequest, res: TylixResponse) => Promise<unknown>): Handler =>
        async (req, res) => {
            await fn(req, res);
        };

    router.get("/api/source-providers", auth(run((req, res) => controller.index(req, res))));
    router.post("/api/source-providers", auth(run((req, res) => controller.store(req, res))));
    router.get("/api/source-providers/:id", auth(run((req, res) => controller.show(req, res))));
    router.put("/api/source-providers/:id", auth(run((req, res) => controller.update(req, res))));
    router.delete("/api/source-providers/:id", auth(run((req, res) => controller.destroy(req, res))));

    router.get("/api/source-providers/:id/repositories", auth(run((req, res) => repos.repositories(req, res))));
    router.get("/api/source-providers/:id/branches", auth(run((req, res) => repos.branches(req, res))));

    // Aliases used by the site-create form.
    router.get("/api/source-controls", auth(run((req, res) => controller.index(req, res))));
    router.get("/api/source-controls/:id/repositories", auth(run((req, res) => repos.repositories(req, res))));
    router.get("/api/source-controls/:id/branches", auth(run((req, res) => repos.branches(req, res))));
}