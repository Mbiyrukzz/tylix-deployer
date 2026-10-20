/**
 * Billing routes (the signed-in user's current team).
 *
 * GET /api/billing   plans, the team's entitlement and what it uses today (any member)
 *
 * Checkout and the Paystack webhook come in the next step.
 */

import type { Router } from "@tylix/core";
import { TeamService } from "../services/TeamService.js";
import { PLANS } from "../services/Plans.js";
import { enforcing, entitlementFor, usageFor } from "../services/EntitlementService.js";

type Handler = Parameters<Router["get"]>[1];

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/billing",
        auth(async (req, res) => {
            const ctx = await TeamService.contextFor(Number(req.user!.userId));
            if (!ctx) return res.status(404).json({ error: "Account not found." });

            const [entitlement, usage] = await Promise.all([
                entitlementFor(ctx.team.id),
                usageFor(ctx.team.id),
            ]);

            return res.json({
                enforced: enforcing(),
                can_manage: TeamService.can(ctx.role, "admin"),
                plans: PLANS.map((p) => ({ id: p.id, name: p.name, price_usd: p.priceUsd, limits: p.limits })),
                entitlement,
                usage,
            });
        }),
    );
}