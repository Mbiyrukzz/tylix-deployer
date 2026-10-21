import type { Router } from "@tylix/core";
import { requireTeam } from "../services/TeamScope.js";
import { accessFor } from "../services/EntitlementService.js";

type Handler = Parameters<Router["get"]>[1];

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // Any signed-in team member. The pages use this to show the view-only banner.
    router.get("/api/billing/access", auth((async (req: any, res: any) => {
        try {
            const teamId = requireTeam(req, res);
            if (!teamId) return;

            return res.json(await accessFor(teamId));
        } catch (error) {
            console.error("[billing] access:", error);
            return res.status(500).json({ error: "Couldn't load billing status." });
        }
    }) as Handler));
}