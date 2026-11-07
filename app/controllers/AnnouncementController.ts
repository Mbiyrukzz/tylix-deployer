import type { TylixRequest, TylixResponse } from "@tylix/core";
import { getAnnouncements } from "../services/HubClient.js";

export class AnnouncementController {
    /** Public: what the Hub is announcing for this product right now. */
    async index(_req: TylixRequest, res: TylixResponse) {
        return res.json({ announcements: await getAnnouncements() });
    }
}