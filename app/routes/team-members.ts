/**
 * Team member routes (the signed-in user's current team).
 *
 * GET    /api/team/members           members with per-member permission flags   (any member)
 * PUT    /api/team/members/:userId   change a role   body { role: "admin" | "member" }   (owner)
 * DELETE /api/team/members/:userId   remove a member                                      (owner, admin)
 * POST   /api/team/leave             leave the team                                       (admin, member)
 *
 * The flags in the list are computed here so the page needs no logic of its
 * own. The PUT and DELETE routes re-check everything in TeamMemberService,
 * so the flags are only a convenience for the UI.
 */

import type { Router } from "@tylix/core";
import { TeamService } from "../services/TeamService.js";
import { TeamMemberService } from "../services/TeamMemberService.js";

type Handler = Parameters<Router["get"]>[1];

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/team/members",
        auth(async (req, res) => {
            const actorId = Number(req.user!.userId);
            const ctx = await TeamService.contextFor(actorId);
            if (!ctx) return res.status(404).json({ error: "Account not found." });

            const isOwner = ctx.role === "owner";
            const isAdmin = ctx.role === "admin";
            const members = await TeamService.members(ctx.team.id);

            return res.json({
                can_leave: !isOwner,
                members: members.map((m) => ({
                    id: m.id,
                    name: m.name,
                    email: m.email,
                    role: m.role,
                    joined: String(m.joined_at).slice(0, 10),
                    is_me: m.id === actorId,
                    can_promote: isOwner && m.role === "member",
                    can_demote: isOwner && m.role === "admin",
                    can_remove:
                        m.id !== actorId &&
                        m.role !== "owner" &&
                        (isOwner || (isAdmin && m.role === "member")),
                })),
            });
        }),
    );

    router.put(
        "/api/team/members/:userId",
        auth(async (req, res) => {
            const actorId = Number(req.user!.userId);
            const ctx = await TeamService.contextFor(actorId);
            if (!ctx) return res.status(404).json({ error: "Account not found." });

            const target = Number(req.params.userId);
            if (!Number.isInteger(target) || target < 1) {
                return res.status(404).json({ error: "Member not found." });
            }

            const role = typeof req.body?.role === "string" ? req.body.role : "";
            const result = await TeamMemberService.setRole(actorId, ctx.team.id, target, role);
            if (!result.ok) return res.status(result.status).json({ error: result.error });

            return res.json({ ok: true });
        }),
    );

    router.delete(
        "/api/team/members/:userId",
        auth(async (req, res) => {
            const actorId = Number(req.user!.userId);
            const ctx = await TeamService.contextFor(actorId);
            if (!ctx) return res.status(404).json({ error: "Account not found." });

            const target = Number(req.params.userId);
            if (!Number.isInteger(target) || target < 1) {
                return res.status(404).json({ error: "Member not found." });
            }

            const result = await TeamMemberService.remove(actorId, ctx.team.id, target);
            if (!result.ok) return res.status(result.status).json({ error: result.error });

            return res.json({ ok: true });
        }),
    );

    router.post(
        "/api/team/leave",
        auth(async (req, res) => {
            const actorId = Number(req.user!.userId);
            const ctx = await TeamService.contextFor(actorId);
            if (!ctx) return res.status(404).json({ error: "Account not found." });

            const result = await TeamMemberService.leave(actorId, ctx.team.id);
            if (!result.ok) return res.status(result.status).json({ error: result.error });

            return res.json({ ok: true });
        }),
    );
}