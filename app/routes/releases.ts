import type { Router } from "@tylix/core";
import { ReleaseController } from "../controllers/ReleaseController.js";

export async function routes(router: Router) {
    const releases = new ReleaseController();

    // Public: the same entries anyone can already read from the Hub.
    router.get("/api/releases", (req, res) => releases.index(req, res));
}