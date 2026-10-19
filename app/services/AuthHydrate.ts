/**
 * Auth hydration: runs after every successful token check and adds the
 * caller's current team to req.user, so routes and controllers can compare
 * row.team_id !== req.user.teamId.
 *
 * Fail-safe for now: if the lookup fails for any reason, the request
 * continues without team fields instead of being rejected. Make this strict
 * (return null to answer 401) only once routes depend on req.user.teamId.
 */

import { TeamService } from "./TeamService.js";

export async function hydrateAuth(user: { userId?: unknown }): Promise<Record<string, unknown>> {
    try {
        const ctx = await TeamService.contextFor(Number(user.userId));
        if (!ctx) return {};

        return { teamId: ctx.team.id, teamRole: ctx.role };
    } catch (error) {
        console.error("[auth] team lookup failed, continuing without team:", error);
        return {};
    }
}