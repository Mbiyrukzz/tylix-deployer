/**
 * Helpers for reading the caller's team and role in controllers and jobs.
 *
 * req.user.teamId and req.user.teamRole are added by the auth hook
 * (AuthHydrate.ts). If the hook couldn't load the team, teamId is missing:
 * requireTeam() then answers 503 instead of pretending the user has no data.
 *
 * Call requireTeam() first, then requireRole().
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { TeamService } from "./TeamService.js";
import type { TeamRole } from "./TeamService.js";

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

/** The caller's role in their current team, or null if it wasn't loaded. */
export function roleOf(req: TylixRequest): TeamRole | null {
    const role = String(req.user?.teamRole ?? "");
    return role === "owner" || role === "admin" || role === "member" ? role : null;
}

/** True when the caller's role is at least `minimum`. */
export function hasRole(req: TylixRequest, minimum: TeamRole): boolean {
    const role = roleOf(req);
    return role !== null && TeamService.can(role, minimum);
}

/** Returns true if the caller has the role, or answers 403 itself and returns false. */
export function requireRole(req: TylixRequest, res: TylixResponse, minimum: TeamRole): boolean {
    if (hasRole(req, minimum)) return true;

    res.status(403);
    res.json({
        error:
            minimum === "owner"
                ? "Only the team owner can do that."
                : "Only team owners and admins can do that.",
    });
    return false;
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

/**
 * True only when both rows resolve to the same real team. Two rows that both
 * resolve to 0 (for example because their creator was deleted) are NOT the
 * same team, which a plain `!==` comparison would wrongly treat as a match.
 */
export async function sameTeam(
    a: { team_id?: unknown; user_id: unknown },
    b: { team_id?: unknown; user_id: unknown },
): Promise<boolean> {
    const x = await teamIdOfRow(a);
    if (x <= 0) return false;
    return x === (await teamIdOfRow(b));
}