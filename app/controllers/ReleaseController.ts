import type { TylixRequest, TylixResponse } from "@tylix/core";
import { getChangelog } from "../services/HubClient.js";

export class ReleaseController {
    async index(_req: TylixRequest, res: TylixResponse) {
        const result = await getChangelog();
        if (!result.ok) {
            res.status(502);
            return res.json({ error: result.error });
        }
        return res.json({ entries: result.entries, stale: Boolean(result.stale) });
    }
}