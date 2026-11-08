import type { TylixRequest, TylixResponse } from "@tylix/core";
import { getStatus, getUptime } from "../services/HubClient.js";

export class StatusController {
    /** Public: the overall state the Hub reports for this product. */
    async index(_req: TylixRequest, res: TylixResponse) {
        return res.json(await getStatus());
    }

    /** Public: 90 days of daily uptime, or null when the Hub can't say. */
    async uptime(_req: TylixRequest, res: TylixResponse) {
        return res.json({ uptime: await getUptime() });
    }
}