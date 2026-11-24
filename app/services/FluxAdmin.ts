/**
 * Service: FluxAdmin
 *
 * Flux admins are the people who run this Tylix Flux install (not team
 * admins, which is a role inside a customer's team). They can list every
 * user and sign in as one of them to fix a problem on their behalf, for
 * example to patch a vulnerable site or lock down a compromised server.
 *
 * Who is a Flux admin
 *   A user whose email is listed in FLUX_ADMIN_EMAILS (comma separated)
 *   AND whose email is verified. It lives in .env on purpose: nothing in the
 *   app (no API, no bug in a form) can make someone a Flux admin.
 *
 * Signing in as a user ("impersonation")
 *   A new session is created for the user, with { imp: { by, until } } in
 *   the session's server-side data (auth_sessions.data). AuthController
 *   copies `by` into the access token as the `imp` claim, so every request
 *   knows an admin is acting. The admin's own session is ended (the browser
 *   only holds one) and a new one is opened when they return.
 *
 * The rules (all enforced server-side):
 *   - only a Flux admin with two-factor on can start one, with a fresh code
 *     and a written reason; every start and end is in admin_impersonations
 *   - never another Flux admin, never themselves, never nested
 *   - at most IMPERSONATION_MINUTES long; the session guard ends it after
 *     that, or as soon as the admin stops being a Flux admin
 *   - BLOCKED routes answer 403: the user's password, two-factor, passkeys
 *     and sessions can't be changed (that would be an account takeover,
 *     not support), and nothing that moves money can run
 *   - step-up codes (deleting a server, ...) are checked against the
 *     ADMIN's two-factor, since the admin is the one at the keyboard
 *   - server log entries written during the request record the admin
 *     (meta.impersonated_by), through impersonationContext
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { TylixRequest, TylixResponse } from "@tylix/core";
import { User } from "../models/User.js";
import type { UserAttributes } from "../models/User.js";

/** Hard cap on one impersonation session. */
export const IMPERSONATION_MINUTES = 60;

/** What is stored in auth_sessions.data for an impersonation session. */
export interface ImpersonationData {
    imp: { by: number; until: number; log: number };
}

/** The admin behind the current request, when an admin is signed in as someone. */
export interface ImpersonationContext {
    adminId: number;
    sessionId: string;
}

/** Set by impersonationMiddleware for the whole request (and anything it awaits). */
export const impersonationContext = new AsyncLocalStorage<ImpersonationContext>();

/** The admin acting in the current request, or null. */
export function currentImpersonator(): ImpersonationContext | null {
    return impersonationContext.getStore() ?? null;
}

/** The emails in FLUX_ADMIN_EMAILS, trimmed and lowercased. */
export function fluxAdminEmails(): Set<string> {
    return new Set(
        String(process.env.FLUX_ADMIN_EMAILS ?? "")
            .split(",")
            .map((e) => e.trim().toLowerCase())
            .filter((e) => e.includes("@")),
    );
}

export function isFluxAdminUser(user: Pick<UserAttributes, "email" | "email_verified_at"> | null | undefined): boolean {
    if (!user || !User.isEmailVerified(user as UserAttributes)) return false;
    return fluxAdminEmails().has(String(user.email ?? "").trim().toLowerCase());
}

export async function isFluxAdmin(userId: unknown): Promise<boolean> {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) return false;
    return isFluxAdminUser(await User.find(id));
}

/** The admin id carried by an access token's `imp` claim, or null. */
export function impersonatorOf(claims: Record<string, unknown> | null | undefined): number | null {
    const id = Number(claims?.imp);
    return Number.isInteger(id) && id > 0 ? id : null;
}

/** The impersonation part of a session's data, or null for a normal session. */
export function impersonationOf(data: unknown): ImpersonationData["imp"] | null {
    const imp = (data as Partial<ImpersonationData> | null | undefined)?.imp;
    if (!imp || typeof imp !== "object") return null;
    const by = Number(imp.by);
    const until = Number(imp.until);
    if (!Number.isInteger(by) || by <= 0 || !Number.isFinite(until)) return null;
    return { by, until, log: Number(imp.log) || 0 };
}

/**
 * Whether an impersonation session may still be used: inside its time
 * limit and while the admin is still a Flux admin. Normal sessions (no
 * impersonation data) always pass here.
 */
export async function impersonationStillAllowed(data: unknown): Promise<boolean> {
    const imp = impersonationOf(data);
    if (!imp) return true;
    if (imp.until <= Date.now()) return false;
    return isFluxAdmin(imp.by);
}

// Routes an admin can't use while signed in as someone, as "METHOD pattern"
// (the pattern the route was registered with). Reading stays allowed.
const BLOCKED = new Set([
    // The account's own credentials and sessions.
    "PUT /api/account/password",
    "POST /api/account/sign-out-everywhere",
    "POST /api/account/two-factor/setup",
    "POST /api/account/two-factor/confirm",
    "POST /api/account/two-factor/disable",
    "POST /api/account/two-factor/recovery-codes",
    "POST /api/account/two-factor/sms/setup",
    "POST /api/account/two-factor/sms/confirm",
    "POST /api/account/two-factor/sms/send-code",
    "POST /api/account/two-factor/sms/disable",
    "POST /api/account/passkeys/options",
    "POST /api/account/passkeys",
    "PUT /api/account/passkeys/:id",
    "DELETE /api/account/passkeys/:id",
    "POST /api/auth/logout-all",
    "DELETE /api/auth/sessions/:id",
    "POST /api/auth/change-password",
    // Money: the subscription and paying a cloud provider's bill.
    "POST /api/billing/checkout",
    "POST /api/billing/cancel",
    "POST /api/providers/:id/billing/payments",
    // Team membership of the account itself.
    "POST /api/team/leave",
    "POST /api/team/invitations/accept",
    // No admin tools from inside someone else's account (only "return").
    "GET /api/admin/users",
    "GET /api/admin/impersonations",
    "POST /api/admin/users/:id/impersonate",
]);

export function blockedWhileImpersonating(method: string, pattern: string | undefined): boolean {
    return Boolean(pattern) && BLOCKED.has(`${method.toUpperCase()} ${pattern}`);
}

type Verify = (token: string) => Promise<Record<string, unknown> | null>;
type Next = () => Promise<unknown>;

function accessTokenOf(req: TylixRequest, cookieName: string): string | null {
    const cookie = (req.cookies as Record<string, string> | undefined)?.[cookieName];
    if (cookie) return cookie;
    const header = String(req.headers?.authorization ?? "");
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    return match ? match[1] : null;
}

/**
 * Global middleware (app/routes/web.ts). For a request made while an admin
 * is signed in as someone: refuses BLOCKED routes, and runs the rest inside
 * impersonationContext. Everything else passes straight through.
 *
 * The token is only checked for its signature here (cheap, no database).
 * requireAuth still does the full check (session alive, time limit) on
 * every protected route right after.
 */
export function impersonationMiddleware(verify: Verify, cookieName: string) {
    return async (req: TylixRequest, res: TylixResponse, next: Next) => {
        const token = accessTokenOf(req, cookieName);
        if (!token) return next();

        const claims = await verify(token).catch(() => null);
        const adminId = impersonatorOf(claims);
        if (!claims || !adminId) return next();

        const pattern = (req as unknown as { route?: { pattern?: string } }).route?.pattern;
        if (blockedWhileImpersonating(String(req.method ?? "GET"), pattern)) {
            res.status(403);
            return res.json({
                error: "You're signed in as this user. Their password, two-factor, passkeys, sessions and billing can't be changed from here.",
                code: "IMPERSONATION_BLOCKED",
            });
        }

        return impersonationContext.run({ adminId, sessionId: String(claims.sid ?? "") }, () => next());
    };
}

/** Answers 403 itself and returns false unless the caller is a Flux admin acting as themselves. */
export async function requireFluxAdmin(req: TylixRequest, res: TylixResponse): Promise<boolean> {
    if (!impersonatorOf(req.user as Record<string, unknown>) && (await isFluxAdmin(req.user?.userId))) return true;

    // 404, not 403: the admin area isn't advertised to everyone else.
    res.status(404);
    res.json({ error: "Not found" });
    return false;
}
