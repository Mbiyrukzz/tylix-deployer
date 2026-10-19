/**
 * Helpers for reading the caller's team in controllers and jobs.
 *
 * req.user.teamId and req.user.teamRole are added by the auth hook
 * (AuthHydrate.ts). If the hook couldn't load the team, teamId is missing:
 * requireTeam() then answers 503 instead of pretending the user has no data.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { TeamService } from "./TeamService.js";

/** The caller's team id, or null if it wasn't loaded. */
export function teamIdOf(req: TylixRequest): number | null {
    const id = Number(req.user?.teamId);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/** Returns the caller's team id, or answers 503 itself and returns null. */
export function requireTeam(req: TylixRequest, res: TylixResponse): number | null {
    const id = teamIdOf(req);
    if (id) return id;

    res.status(503);
    res.json({ error: "Your team couldn't be loaded. Try again in a moment." });
    return null;
}

/**
 * The team a stored row belongs to. Uses team_id when it is set. Rows saved
 * before every create path stamped team_id fall back to the creator's team.
 * Returns 0 when nothing can be resolved.
 */
export async function teamIdOfRow(row: { team_id?: unknown; user_id: unknown }): Promise<number> {
    const stamped = Number(row.team_id);
    if (Number.isInteger(stamped) && stamped > 0) return stamped;

    const ctx = await TeamService.contextFor(Number(row.user_id));
    return ctx ? ctx.team.id : 0;
}