/**
 * Flux admin routes (the people who run this install; see
 * app/services/FluxAdmin.ts for who that is and every rule).
 *
 * GET  /api/admin/users?q=&page=&per_page=      every user, searchable by name or email
 * GET  /api/admin/impersonations                the last 25 "sign in as" sessions
 * POST /api/admin/users/:id/impersonate         { reason, code } -> signs this browser in as the user
 * POST /api/admin/impersonation/stop            back to the admin's own account
 *
 * Everything but /stop answers 404 to anyone who isn't a Flux admin acting
 * as themselves. /stop is called from INSIDE the user's account, so it
 * checks the impersonation session instead.
 */

import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { applyCookies } from "@tylix/auth";
import { User } from "../models/User.js";
import type { UserAttributes } from "../models/User.js";
import { Team } from "../models/Team.js";
import { Server } from "../models/Server.js";
import { AuthSession } from "../models/AuthSession.js";
import { AdminImpersonation, isoTime } from "../models/AdminImpersonation.js";
import { authController } from "../controllers/AuthController.js";
import { TwoFactorService } from "../services/TwoFactorService.js";
import { SmsTwoFactorService } from "../services/SmsTwoFactorService.js";
import { clientIp, createGuard, requireStepUp } from "../services/RouteGuard.js";
import {
    IMPERSONATION_MINUTES,
    impersonationOf,
    impersonatorOf,
    isFluxAdmin,
    isFluxAdminUser,
    requireFluxAdmin,
} from "../services/FluxAdmin.js";

type Handler = Parameters<Router["get"]>[1];

const REASON_MIN = 10;
const REASON_MAX = 500;
const PER_PAGE_CHOICES = [10, 20, 50, 100];

// Starting one needs a 2FA code anyway; this just stops a script hammering it.
const startGuard = createGuard({ max: 10, windowMs: 15 * 60_000, what: "sign-in-as attempts" });

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

async function hasTwoFactor(userId: number): Promise<boolean> {
    if (await TwoFactorService.isEnabled(userId)) return true;
    const sms = await SmsTwoFactorService.find(userId);
    return Boolean(sms?.confirmed_at);
}

/** Latest last_used_at per user, over their live sessions. */
async function lastSeen(userIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (userIds.length === 0) return out;
    const rows = (await AuthSession.query().whereIn("user_id", userIds).get()) as Array<{ user_id: number; last_used_at: string }>;
    for (const r of rows) {
        const id = Number(r.user_id);
        const prev = out.get(id);
        if (r.last_used_at && (!prev || r.last_used_at > prev)) out.set(id, r.last_used_at);
    }
    return out;
}

async function describeUser(u: UserAttributes, seen: Map<number, string>) {
    const teamId = Number(u.current_team_id) || 0;
    const team = teamId ? ((await Team.find(teamId)) as { id: number; name: string } | null) : null;
    const servers = team ? await Server.query().where("team_id", team.id).count() : 0;

    return {
        id: u.id,
        name: u.name,
        email: u.email,
        avatar_url: User.avatarUrl(u),
        verified: User.isEmailVerified(u),
        two_factor: await hasTwoFactor(u.id),
        team: team ? { id: team.id, name: team.name } : null,
        servers,
        joined_at: isoTime(u.created_at),
        last_seen_at: isoTime(seen.get(u.id)),
        flux_admin: isFluxAdminUser(u),
    };
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/admin/users",
        auth(async (req, res) => {
            if (!(await requireFluxAdmin(req, res))) return;

            const q = text(req.query?.q).trim().toLowerCase().slice(0, 100);
            const perPageAsked = Number(req.query?.per_page);
            const perPage = PER_PAGE_CHOICES.includes(perPageAsked) ? perPageAsked : 20;

            // The ORM has no OR/LIKE-on-two-columns, so the filter runs here.
            // Password hashes never leave this function.
            let users = (await User.all()).sort((a, b) => b.id - a.id);
            if (q) {
                users = users.filter(
                    (u) => String(u.email).toLowerCase().includes(q) || String(u.name ?? "").toLowerCase().includes(q) || String(u.id) === q,
                );
            }

            const total = users.length;
            const pages = Math.max(1, Math.ceil(total / perPage));
            const page = Math.min(Math.max(1, Math.floor(Number(req.query?.page)) || 1), pages);
            const slice = users.slice((page - 1) * perPage, page * perPage);

            const seen = await lastSeen(slice.map((u) => u.id));
            const rows = [];
            for (const u of slice) rows.push(await describeUser(u, seen));

            // The admin's own second factor, for the "Sign in as" dialog.
            const adminId = Number(req.user!.userId);
            const totp = await TwoFactorService.isEnabled(adminId);
            const sms = Boolean((await SmsTwoFactorService.find(adminId))?.confirmed_at);

            return res.json({
                users: rows,
                page,
                pages,
                per_page: perPage,
                total,
                me: { two_factor: totp || sms, totp, sms },
                limit_minutes: IMPERSONATION_MINUTES,
            });
        }),
    );

    router.get(
        "/api/admin/impersonations",
        auth(async (req, res) => {
            if (!(await requireFluxAdmin(req, res))) return;

            const rows = await AdminImpersonation.recent(25);
            const ids = [...new Set(rows.flatMap((r) => [Number(r.admin_user_id), Number(r.target_user_id)]))];
            const people = new Map<number, UserAttributes>();
            for (const id of ids) {
                const u = await User.find(id);
                if (u) people.set(id, u);
            }
            const now = Date.now();

            return res.json({
                impersonations: rows.map((r) => {
                    const admin = people.get(Number(r.admin_user_id));
                    const target = people.get(Number(r.target_user_id));
                    const expiresAt = isoTime(r.expires_at);
                    const endedAt = isoTime(r.ended_at);
                    const live = !endedAt && expiresAt !== null && Date.parse(expiresAt) > now;
                    return {
                        id: r.id,
                        admin: admin ? { id: admin.id, name: admin.name, email: admin.email } : null,
                        target: target ? { id: target.id, name: target.name, email: target.email } : null,
                        reason: r.reason,
                        ip: r.ip,
                        started_at: isoTime(r.started_at),
                        expires_at: expiresAt,
                        ended_at: endedAt ?? (live ? null : expiresAt),
                        end_reason: r.end_reason ?? (live ? null : "expired"),
                        active: live,
                    };
                }),
            });
        }),
    );

    router.post(
        "/api/admin/users/:id/impersonate",
        auth(async (req: TylixRequest, res: TylixResponse) => {
            if (!(await requireFluxAdmin(req, res))) return;
            if (!startGuard(req, res)) return;

            const adminId = Number(req.user!.userId);
            const targetId = Number(req.params?.id);
            if (!Number.isInteger(targetId) || targetId <= 0) {
                return res.status(404).json({ error: "User not found." });
            }
            if (targetId === adminId) {
                return res.status(422).json({ error: "That's your own account." });
            }

            const target = await User.find(targetId);
            if (!target) return res.status(404).json({ error: "User not found." });
            if (isFluxAdminUser(target)) {
                return res.status(403).json({ error: "You can't sign in as another Flux admin." });
            }

            const reason = text(req.body?.reason).trim();
            if (reason.length < REASON_MIN) {
                return res.status(422).json({ errors: { reason: [`Say why (at least ${REASON_MIN} characters): a ticket, an incident, a CVE.`] } });
            }
            if (reason.length > REASON_MAX) {
                return res.status(422).json({ errors: { reason: [`Keep it under ${REASON_MAX} characters.`] } });
            }

            // Signing in as anyone is the most powerful thing in the app, so
            // it is never protected by a password alone.
            if (!(await hasTwoFactor(adminId))) {
                return res.status(403).json({
                    error: "Turn on two-factor authentication (Settings → Two-factor) before signing in as a user.",
                    code: "TWO_FACTOR_SETUP_REQUIRED",
                });
            }
            // Last check before acting, so a code is never spent on a request
            // that was going to fail anyway.
            if (!(await requireStepUp(req, res, `sign in as ${target.email}`))) return;

            const { auth: sessions } = authController();
            const now = Date.now();
            const until = now + IMPERSONATION_MINUTES * 60_000;

            const log = (await AdminImpersonation.create({
                admin_user_id: adminId,
                target_user_id: target.id,
                reason,
                session_sid: "",
                ip: clientIp(req).slice(0, 64),
                user_agent: String(req.headers?.["user-agent"] ?? "").slice(0, 512) || null,
                started_at: new Date(now).toISOString(),
                expires_at: new Date(until).toISOString(),
            })) as { id: number } | null;
            if (!log) return res.status(500).json({ error: "Couldn't record the sign-in. Nothing was changed." });

            // Not "remember me": the cookies go when the browser closes, and
            // the session guard ends it after IMPERSONATION_MINUTES anyway.
            const { session, cookies } = await sessions.signIn(req, target.id, {
                persistent: false,
                data: { imp: { by: adminId, until, log: log.id } },
            });
            await AdminImpersonation.update(log.id, { session_sid: session.id });

            // This browser now holds the user's session, so the admin's own
            // one would only linger unused. It is ended; /stop opens a new one.
            const adminSid = String(req.user?.sid ?? "");
            if (adminSid) await sessions.revokeSession(adminSid);

            console.warn(`[admin] Flux admin ${adminId} signed in as user ${target.id} (impersonation ${log.id}).`);

            applyCookies(res, cookies);
            return res.json({ ok: true, redirect: "/dashboard" });
        }),
    );

    router.post(
        "/api/admin/impersonation/stop",
        auth(async (req, res) => {
            const claimed = impersonatorOf(req.user as Record<string, unknown>);
            if (!claimed) return res.status(400).json({ error: "You aren't signed in as anyone." });

            const { auth: sessions } = authController();
            const sid = String(req.user?.sid ?? "");
            // The session's own (server-side) data decides who goes back.
            const record = await sessions.adapter.get(sid);
            const imp = impersonationOf(record?.data);

            await sessions.revokeSession(sid);
            await AdminImpersonation.end(sid, "stopped");

            if (!imp || imp.by !== claimed || !(await isFluxAdmin(imp.by))) {
                applyCookies(res, sessions.clearCookies(req));
                return res.json({ ok: true, redirect: "/login" });
            }

            console.warn(`[admin] Flux admin ${imp.by} stopped impersonation ${imp.log}.`);

            const { cookies } = await sessions.signIn(req, imp.by, { persistent: true });
            applyCookies(res, cookies);
            return res.json({ ok: true, redirect: "/admin" });
        }),
    );
}
