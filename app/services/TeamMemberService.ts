/**
 * Service: TeamMemberService
 *
 * Changing roles, removing members and leaving a team.
 *
 * Rules:
 *   - only the owner changes roles, and only between admin and member
 *   - the owner's own role never changes, and nobody can change their own role
 *   - owner and admin can remove plain members; only the owner removes an admin
 *   - the owner can't be removed and can't leave
 *   - a removed or departed person keeps no access. Servers, sites and
 *     connections they brought into the team stay with the team.
 *
 * Roles are always re-read from team_members here, never trusted from the
 * request, so a stale session can't use an old role.
 */

import { TeamMember } from "../models/TeamMember.js";
import { TeamService } from "./TeamService.js";
import type { TeamRole } from "./TeamService.js";

export type MemberResult = { ok: true } | { ok: false; status: number; error: string };

const fail = (status: number, error: string): MemberResult => ({ ok: false, status, error });

export const TeamMemberService = {
    async setRole(
        actorId: number,
        teamId: number,
        targetUserId: number,
        newRole: string,
    ): Promise<MemberResult> {
        if (newRole !== "admin" && newRole !== "member") {
            return fail(422, "Role must be admin or member.");
        }

        const actor = await TeamService.membership(teamId, actorId);
        if (!actor || actor.role !== "owner") {
            return fail(403, "Only the team owner can change roles.");
        }

        if (targetUserId === actorId) {
            return fail(409, "You can't change your own role.");
        }

        const target = await TeamService.membership(teamId, targetUserId);
        if (!target) return fail(404, "Member not found.");

        if (target.role === "owner") {
            return fail(409, "The owner's role can't be changed.");
        }

        if (target.role !== newRole) {
            await TeamMember.update(target.id, { role: newRole });
        }

        return { ok: true };
    },

    async remove(actorId: number, teamId: number, targetUserId: number): Promise<MemberResult> {
        if (targetUserId === actorId) {
            return fail(409, "Use Leave team to remove yourself.");
        }

        const actor = await TeamService.membership(teamId, actorId);
        if (!actor || !TeamService.can(actor.role as TeamRole, "admin")) {
            return fail(403, "Only team owners and admins can remove members.");
        }

        const target = await TeamService.membership(teamId, targetUserId);
        if (!target) return fail(404, "Member not found.");

        if (target.role === "owner") {
            return fail(409, "The owner can't be removed.");
        }

        if (actor.role !== "owner" && target.role !== "member") {
            return fail(403, "Only the owner can remove an admin.");
        }

        await TeamMember.delete(target.id);
        return { ok: true };
    },

    async leave(actorId: number, teamId: number): Promise<MemberResult> {
        const me = await TeamService.membership(teamId, actorId);
        if (!me) return fail(404, "You're not on this team.");

        if (me.role === "owner") {
            return fail(409, "The owner can't leave the team.");
        }

        await TeamMember.delete(me.id);
        return { ok: true };
    },
};