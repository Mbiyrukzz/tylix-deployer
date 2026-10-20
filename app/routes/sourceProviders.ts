/**
 * Source control connections (GitHub / GitLab). Team-scoped. Any member can
 * list and view connections; adding, changing and deleting one, and browsing
 * repositories and branches with its token, need the admin role.
 *
 * GET    /api/source-providers                       any member
 * POST   /api/source-providers                       admin
 * GET    /api/source-providers/:id                   any member
 * PUT    /api/source-providers/:id                   admin
 * DELETE /api/source-providers/:id                   admin
 * GET    /api/source-providers/:id/repositories      admin: every repo the token can see
 * GET    /api/source-providers/:id/branches?repo=owner/name   admin
 *
 * GET    /api/source-controls[...]   aliases used by the site form
 *
 * Connection logic lives in SourceProviderController, repo/branch listing in
 * SourceRepositoryController.
 */
import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { SourceProviderController } from "../controllers/SourceProviderController.js";
import { SourceRepositoryController } from "../controllers/SourceRepositoryController.js";
import { requireRole } from "../services/TeamScope.js";

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

    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.get("/api/source-providers", auth(run((req, res) => controller.index(req, res))));
    router.post("/api/source-providers", write(run((req, res) => controller.store(req, res))));
    router.get("/api/source-providers/:id", auth(run((req, res) => controller.show(req, res))));
    router.put("/api/source-providers/:id", write(run((req, res) => controller.update(req, res))));
    router.delete("/api/source-providers/:id", write(run((req, res) => controller.destroy(req, res))));

    router.get("/api/source-providers/:id/repositories", write(run((req, res) => repos.repositories(req, res))));
    router.get("/api/source-providers/:id/branches", write(run((req, res) => repos.branches(req, res))));

    // Aliases used by the site-create form.
    router.get("/api/source-controls", auth(run((req, res) => controller.index(req, res))));
    router.get("/api/source-controls/:id/repositories", write(run((req, res) => repos.repositories(req, res))));
    router.get("/api/source-controls/:id/branches", write(run((req, res) => repos.branches(req, res))));
}