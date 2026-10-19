/**
 * Team routes (the signed-in user's current team).
 *
 * GET  /api/team     team, the caller's role and the member list
 * PUT  /api/team     rename the team (owner or admin)
 *
 * Invitations, role changes and removing members come next.
 */

import type { Router } from "@tylix/core";
import { Team } from "../models/Team.js";
import { User } from "../models/User.js";
import { TeamService } from "../services/TeamService.js";

type Handler = Parameters<Router["get"]>[1];

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/team",
        auth(async (req, res) => {
            const user = await User.find(req.user!.userId as number);
            if (!user) {
                return res.status(404).json({ error: "Account not found." });
            }

            const { team, role } = await TeamService.ensureTeam(user);
            const members = await TeamService.members(team.id);

            return res.json({ team, role, members });
        }),
    );

    router.put(
        "/api/team",
        auth(async (req, res) => {
            const user = await User.find(req.user!.userId as number);
            if (!user) {
                return res.status(404).json({ error: "Account not found." });
            }

            const { team, role } = await TeamService.ensureTeam(user);
            if (!TeamService.can(role, "admin")) {
                return res.status(403).json({ error: "Only team owners and admins can rename the team." });
            }

            const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
            if (!name) {
                return res.status(422).json({ errors: { name: ["Team name is required."] } });
            }
            if (name.length > 100) {
                return res.status(422).json({ errors: { name: ["Team name must be at most 100 characters."] } });
            }

            await Team.update(team.id, { name });
            const fresh = await Team.find(team.id);

            return res.json({ team: fresh, role });
        }),
    );
}