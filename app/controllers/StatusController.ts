import type { TylixRequest, TylixResponse } from "@tylix/core";
import { getStatus } from "../services/HubClient.js";

export class StatusController {
    async index(_req: TylixRequest, res: TylixResponse) {
        return res.json(await getStatus());
    }
}