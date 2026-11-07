import type { Router } from "@tylix/core";
import { StatusController } from "../controllers/StatusController.js";
import { AnnouncementController } from "../controllers/AnnouncementController.js";
import { startHeartbeat } from "../services/HubReporter.js";

let started = false;

export async function routes(router: Router) {
    const status = new StatusController();
    const announcements = new AnnouncementController();

    // Public: the same overall state the Hub already publishes.
    router.get("/api/status", (req, res) => status.index(req, res));

    // Public: incidents, maintenance and notices from the Hub.
    router.get("/api/announcements", (req, res) => announcements.index(req, res));

    // routes() runs once when the web server boots. Guard against a double start.
    if (!started) {
        started = true;
        startHeartbeat("0.1.0");
    }
}