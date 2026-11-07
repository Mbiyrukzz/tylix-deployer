import type { Router } from "@tylix/core";
import { StatusController } from "../controllers/StatusController.js";
import { startHeartbeat } from "../services/HubReporter.js";

let started = false;

export async function routes(router: Router) {
    const status = new StatusController();

    // Public: the same overall state the Hub already publishes.
    router.get("/api/status", (req, res) => status.index(req, res));

    // routes() runs once when the web server boots. Guard against a double start.
    if (!started) {
        started = true;
        startHeartbeat("0.1.0");
    }
}