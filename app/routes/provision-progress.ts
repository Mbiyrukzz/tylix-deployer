import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { Provision } from "../models/Provision.js";
import { requireTeam, teamIdOfRow } from "../services/TeamScope.js";
import { progressOf } from "../services/ProvisionProgress.js";
import type { ProvisionRow } from "../services/ProvisionProgress.js";
import { signProvisionTicket } from "../services/ProvisionTicket.js";

type RouteContext = { auth: (handler: any) => any };

/** Loads a provision and answers 404 itself if it is missing or on another team. */
async function findOwned(req: TylixRequest, res: TylixResponse): Promise<ProvisionRow | null> {
    const teamId = requireTeam(req, res);
    if (!teamId) return null;

    const row = (await Provision.find(req.params.id)) as ProvisionRow | null;

    if (!row || (await teamIdOfRow(row)) !== teamId) {
        res.status(404);
        res.json({ error: "Provision not found." });
        return null;
    }

    return row;
}

export async function routes(router: Router, { auth }: RouteContext) {
    // One-off read, used for the first paint and as the fallback when the socket drops.
    router.get(
        "/api/provisions/:id/progress",
        auth(async (req: TylixRequest, res: TylixResponse) => {
            const row = await findOwned(req, res);
            if (!row) return;

            return res.json(progressOf(row));
        }),
    );

    router.post(
        "/api/provisions/:id/progress-ticket",
        auth(async (req: TylixRequest, res: TylixResponse) => {
            const row = await findOwned(req, res);
            if (!row) return;

            return res.json({ ticket: signProvisionTicket(Number(req.user?.userId), row.id) });
        }),
    );
}