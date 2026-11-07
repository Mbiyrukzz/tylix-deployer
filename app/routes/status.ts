import type { Router } from "@tylix/core";
import { StatusController } from "../controllers/StatusController.js";

export async function routes(router: Router) {
    const status = new StatusController();

    // Public: the same overall state the Hub already publishes.
    router.get("/api/status", (req, res) => status.index(req, res));
}