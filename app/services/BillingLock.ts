/**
 * Service: BillingLock
 *
 * One place that makes every write route view-only for a lapsed team.
 * Wrap `auth` once, at the top of each routes file (guard-routes.mjs does this):
 *
 *   export async function routes(router, { auth: baseAuth }) {
 *       const auth = withBillingLock(baseAuth);
 *       ...
 *
 * Every POST, PUT, PATCH and DELETE that goes through that auth() then
 * answers 402 while the team is lapsed (and BILLING_ENFORCE=1). GET routes
 * and anything in EXEMPT are untouched.
 *
 * The check runs INSIDE auth(), after AuthHydrate has set req.user.teamId.
 * If the team couldn't be loaded the check is skipped, and the route's own
 * requireTeam() answers 503 as before.
 *
 * Fails closed: a new route is locked by default. Add it to EXEMPT only if a
 * locked team must still be able to do it.
 */

import { teamIdOf } from "./TeamScope.js";
import { requireActive } from "./EntitlementService.js";

const WRITES = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Writes a view-only team must still be able to do. Adjust to your real paths.
 * (Routes that don't go through auth(), like login, register and the Paystack
 * webhook, never reach this check, so they don't need listing.)
 */
const EXEMPT: RegExp[] = [
    /^\/api\/billing(\/|$)/, // pay, checkout, verify, cancel
    /^\/api\/webhooks(\/|$)/, // Paystack
    /^\/api\/auth(\/|$)/, // logout, refresh
    /^\/api\/account(\/|$)/, // the person's own password, 2FA, sign-out-everywhere (not team data)
    /\/stats-ticket$/, // a POST, but it only opens the live stats stream
    /^\/api\/team\/invitations\/(accept|preview)$/, // joining another team; that team's own limits apply
    /^\/api\/team\/leave$/, // a locked team's member can always walk away
];

function pathOf(req: unknown): string {
    const r = req as { path?: string; originalUrl?: string; url?: string };
    return String(r.path ?? r.originalUrl ?? r.url ?? "").split("?")[0];
}

let warnedShape = false;

export function withBillingLock<H extends (...args: any[]) => unknown>(
    auth: (handler: H) => H,
): (handler: H) => H {
    return (handler) =>
        auth((async (req: any, res: any, next?: any) => {
            const method = String(req.method ?? "").toUpperCase();

            if (!method && !warnedShape) {
                warnedShape = true;
                console.error("[billing] BillingLock can't read req.method; writes are NOT being locked.");
            }

            if (WRITES.has(method) && !EXEMPT.some((rule) => rule.test(pathOf(req)))) {
                const teamId = teamIdOf(req);
                if (teamId && !(await requireActive(res, teamId))) return;
            }

            return handler(req, res, next);
        }) as unknown as H);
}