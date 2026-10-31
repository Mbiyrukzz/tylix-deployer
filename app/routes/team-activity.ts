/**
 * Team activity routes (the signed-in user's current team).
 *
 * GET /api/team/activity?page=1&per_page=10&user=5
 *     paginated activity feed, plus per-member totals
 *       page      1-based page number (default 1)
 *       per_page  rows per page (default 10, max 100)
 *       user      only this member's activity (optional)
 * GET /api/team/members/:userId?page=1&per_page=15&kind=server
 *     one member's details, totals and a paginated activity list
 *       kind  only this kind of activity (optional, see TeamActivityService)
 *
 * Visibility: owners and admins see everyone's activity. A plain member only
 * sees their own. The role is read from the team context on every request.
 */

import type { Router } from "@tylix/core";
import { TeamService } from "../services/TeamService.js";
import { TeamActivityService } from "../services/TeamActivityService.js";

type Handler = Parameters<Router["get"]>[1];

function intOf(req: unknown, key: string, fallback: number, min: number, max: number): number {
    const query = (req as { query?: Record<string, unknown> }).query;
    const n = Number(query?.[key]);
    if (!Number.isInteger(n) || n < min) return fallback;
    return Math.min(n, max);
}

function strOf(req: unknown, key: string): string {
    const query = (req as { query?: Record<string, unknown> }).query;
    const v = query?.[key];
    return typeof v === "string" ? v : "";
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/team/activity",
        auth(async (req, res) => {
            const actorId = Number(req.user!.userId);
            const ctx = await TeamService.contextFor(actorId);
            if (!ctx) return res.status(404).json({ error: "Account not found." });

            const seesAll = TeamService.can(ctx.role, "admin");
            const members = await TeamService.members(ctx.team.id);
            const names = new Map(members.map((m) => [m.id, m.name]));

            let events = await TeamActivityService.collect(ctx.team.id);
            if (!seesAll) events = events.filter((e) => e.user_id === actorId);

            // Totals always cover everything the caller may see, not just this page.
            const summary = TeamActivityService.summarize(events);

            const filterUser = intOf(req, "user", 0, 0, Number.MAX_SAFE_INTEGER);
            const feed = filterUser > 0 ? events.filter((e) => e.user_id === filterUser) : events;

            const perPage = intOf(req, "per_page", 10, 1, 100);
            const total = feed.length;
            const pages = Math.max(1, Math.ceil(total / perPage));
            const page = Math.min(intOf(req, "page", 1, 1, 100000), pages);

            return res.json({
                scope: seesAll ? "team" : "self",
                summary,
                page,
                per_page: perPage,
                total,
                pages,
                events: feed.slice((page - 1) * perPage, page * perPage).map((e) => ({
                    ...e,
                    user_name: names.get(e.user_id) ?? "Former member",
                })),
            });
        }),
    );

    router.get(
        "/api/team/members/:userId",
        auth(async (req, res) => {
            const actorId = Number(req.user!.userId);
            const ctx = await TeamService.contextFor(actorId);
            if (!ctx) return res.status(404).json({ error: "Account not found." });

            const targetId = Number(req.params.userId);
            if (!Number.isInteger(targetId) || targetId < 1) {
                return res.status(404).json({ error: "Member not found." });
            }

            // Non-members get the same 404 as a missing user.
            const membership = await TeamService.membership(ctx.team.id, targetId);
            if (!membership) return res.status(404).json({ error: "Member not found." });

            if (targetId !== actorId && !TeamService.can(ctx.role, "admin")) {
                return res.status(403).json({ error: "Only team owners and admins can see other members' activity." });
            }

            const members = await TeamService.members(ctx.team.id);
            const member = members.find((m) => m.id === targetId);
            if (!member) return res.status(404).json({ error: "Member not found." });

            const all = await TeamActivityService.collect(ctx.team.id);
            const events = all.filter((e) => e.user_id === targetId);
            const summary = TeamActivityService.summarize(events)[String(targetId)];

            const by_kind = TeamActivityService.kinds()
                .map((k) => ({ kind: k.kind, label: k.plural, count: summary?.by_kind[k.kind] ?? 0 }))
                .filter((k) => k.count > 0)
                .sort((a, b) => b.count - a.count);

            const labels = new Map(TeamActivityService.kinds().map((k) => [k.kind, k.plural]));
            const kindParam = strOf(req, "kind");
            const feed = kindParam && labels.has(kindParam) ? events.filter((e) => e.kind === kindParam) : events;

            const perPage = intOf(req, "per_page", 15, 1, 100);
            const total = feed.length;
            const pages = Math.max(1, Math.ceil(total / perPage));
            const page = Math.min(intOf(req, "page", 1, 1, 100000), pages);

            return res.json({
                member: {
                    id: member.id,
                    name: member.name,
                    email: member.email,
                    role: member.role,
                    joined: String(member.joined_at).slice(0, 10),
                    is_me: member.id === actorId,
                },
                stats: {
                    total: summary?.total ?? 0,
                    last_active: summary?.last_at ?? null,
                    by_kind,
                },
                page,
                per_page: perPage,
                total,
                pages,
                events: feed.slice((page - 1) * perPage, page * perPage).map((e) => ({
                    ...e,
                    user_name: member.name,
                    kind_label: labels.get(e.kind) ?? e.kind,
                })),
            });
        }),
    );
}