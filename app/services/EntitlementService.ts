/**
 * Service: EntitlementService
 *
 * Answers "what is this team allowed to do?" in one place.
 *
 *   entitlementFor(teamId)          the plan, its limits and the subscription state
 *   usageFor(teamId)                what the team uses today
 *   check(teamId, resource)         can the team add one more?
 *   requireWithin(...)              for controllers: answers 402 itself when over the limit
 *   requireRoomFor(...)             same, for several resources at once (joining a team)
 *
 * States:
 *   legacy   no subscription row. No limits. (Everyone who existed before billing.)
 *   active   a paid or trial plan whose status is active, trialing or past_due,
 *            or canceled but still inside the period it paid for
 *   lapsed   the subscription ended. Nothing is deleted or stopped; only adding
 *            new servers, sites, connections and members is refused.
 *
 * BILLING_ENFORCE=1 turns refusals on. Without it, check() still reports
 * "within: false" and the require functions log a warning, but let the request through.
 */

import type { TylixResponse } from "@tylix/core";
import { Subscription, type SubscriptionAttributes } from "../models/Subscription.js";
import { Server } from "../models/Server.js";
import { Site } from "../models/Site.js";
import { Provider } from "../models/Provider.js";
import { TeamMember } from "../models/TeamMember.js";
import { TeamInvitation, type TeamInvitationAttributes } from "../models/TeamInvitation.js";
import {
    LAPSED_LIMITS,
    LEGACY_LIMITS,
    RESOURCE_LABELS,
    getPlanDef,
    type Limits,
    type PlanId,
    type Resource,
} from "./Plans.js";

const LIVE_STATUSES = ["active", "trialing", "past_due"];

export interface Entitlement {
    state: "legacy" | "active" | "lapsed";
    plan: PlanId | null;
    planName: string;
    status: string;
    limits: Limits;
    periodEnd: string;
    cancelAtPeriodEnd: boolean;
}

export interface CheckResult {
    resource: Resource;
    planName: string;
    state: Entitlement["state"];
    used: number;
    limit: number | null;
    /** Within the plan's limit. */
    within: boolean;
    /** What the caller should do: within, or enforcement is off. */
    allowed: boolean;
    enforced: boolean;
}

export const enforcing = () => process.env.BILLING_ENFORCE === "1";

async function subscriptionOf(teamId: number): Promise<SubscriptionAttributes | null> {
    const rows = (await Subscription.all()) as SubscriptionAttributes[];

    // A "pending" row is a checkout that hasn't been paid yet. It changes nothing.
    const mine = rows
        .filter((r) => Number(r.team_id) === teamId && r.status !== "pending")
        .sort((a, b) => b.id - a.id);

    return mine[0] ?? null;
}

export async function entitlementFor(teamId: number): Promise<Entitlement> {
    const sub = await subscriptionOf(teamId);

    if (!sub) {
        return {
            state: "legacy",
            plan: null,
            planName: "Legacy",
            status: "none",
            limits: LEGACY_LIMITS,
            periodEnd: "",
            cancelAtPeriodEnd: false,
        };
    }

    const def = getPlanDef(sub.plan);
    const periodEnd = String(sub.current_period_end ?? "");
    const stillPaid = periodEnd !== "" && new Date(periodEnd).getTime() > Date.now();
    const live = LIVE_STATUSES.includes(sub.status) || (sub.status === "canceled" && stillPaid);

    if (!def || !live) {
        return {
            state: "lapsed",
            plan: def?.id ?? null,
            planName: def?.name ?? "No plan",
            status: sub.status,
            limits: LAPSED_LIMITS,
            periodEnd,
            cancelAtPeriodEnd: false,
        };
    }

    return {
        state: "active",
        plan: def.id,
        planName: def.name,
        status: sub.status,
        limits: def.limits,
        periodEnd,
        cancelAtPeriodEnd: Number(sub.cancel_at_period_end) === 1,
    };
}

export async function usageOf(teamId: number, resource: Resource): Promise<number> {
    const inTeam = (row: { team_id?: unknown }) => Number(row.team_id) === teamId;

    switch (resource) {
        case "servers":
            return ((await Server.all()) as { team_id?: unknown }[]).filter(inTeam).length;
        case "sites":
            return ((await Site.all()) as { team_id?: unknown }[]).filter(inTeam).length;
        case "providers":
            return ((await Provider.all()) as { team_id?: unknown }[]).filter(inTeam).length;
        case "members": {
            const members = ((await TeamMember.all()) as { team_id?: unknown }[]).filter(inTeam).length;
            // A pending invitation holds a seat, so invites can't overshoot the limit.
            const pending = ((await TeamInvitation.all()) as TeamInvitationAttributes[]).filter(
                (i) =>
                    Number(i.team_id) === teamId &&
                    !i.accepted_at &&
                    new Date(i.expires_at).getTime() > Date.now(),
            ).length;
            return members + pending;
        }
    }
}

export async function usageFor(teamId: number): Promise<Record<Resource, number>> {
    const [members, servers, sites, providers] = await Promise.all([
        usageOf(teamId, "members"),
        usageOf(teamId, "servers"),
        usageOf(teamId, "sites"),
        usageOf(teamId, "providers"),
    ]);
    return { members, servers, sites, providers };
}

/** Can the team add `adding` more of this resource? */
export async function check(teamId: number, resource: Resource, adding = 1): Promise<CheckResult> {
    const [ent, used] = await Promise.all([entitlementFor(teamId), usageOf(teamId, resource)]);

    const limit = ent.limits[resource];
    const within = limit === null || used + adding <= limit;

    return {
        resource,
        planName: ent.planName,
        state: ent.state,
        used,
        limit,
        within,
        allowed: within || !enforcing(),
        enforced: enforcing(),
    };
}

function refusal(result: CheckResult): string {
    const label = RESOURCE_LABELS[result.resource];

    if (result.state === "lapsed") {
        return "Your subscription has ended, so you can't add anything new. Renew your plan to continue.";
    }
    return `Your ${result.planName} plan allows ${result.limit} ${label}. Upgrade your plan to add more.`;
}

/** Worded for the person joining, who is not the one who can upgrade. */
function incomingRefusal(result: CheckResult, adding: number): string {
    const label = RESOURCE_LABELS[result.resource];

    if (result.state === "lapsed") {
        return "This team's subscription has ended, so it can't take on anything new right now. Ask the team owner to renew the plan.";
    }
    return `This team's ${result.planName} plan allows ${result.limit} ${label}. It has ${result.used} and you would bring ${adding} more. Ask the team owner to upgrade, or move some of yours out first.`;
}

/**
 * For controllers. Returns true to carry on, or answers 402 itself and returns false.
 *
 *   if (!(await requireWithin(res, teamId, "servers"))) return;
 */
export async function requireWithin(
    res: TylixResponse,
    teamId: number,
    resource: Resource,
    adding = 1,
): Promise<boolean> {
    const result = await check(teamId, resource, adding);

    if (!result.within && !result.enforced) {
        console.warn(
            `[billing] team ${teamId} is over its ${result.planName} limit for ${resource} (${result.used}/${result.limit}); not enforced.`,
        );
    }

    if (result.allowed) return true;

    res.status(402);
    res.json({
        error: refusal(result),
        code: "plan_limit",
        resource,
        limit: result.limit,
        used: result.used,
    });
    return false;
}

/**
 * For joining a team: checks several resources at once, e.g.
 *
 *   requireRoomFor(res, teamId, { servers: 2, sites: 5, providers: 1 })
 *
 * Returns true to carry on, or answers 402 for the first resource that doesn't fit.
 */
export async function requireRoomFor(
    res: TylixResponse,
    teamId: number,
    incoming: Partial<Record<Resource, number>>,
): Promise<boolean> {
    for (const resource of Object.keys(incoming) as Resource[]) {
        const adding = Number(incoming[resource]) || 0;
        if (adding <= 0) continue;

        const result = await check(teamId, resource, adding);

        if (!result.within && !result.enforced) {
            console.warn(
                `[billing] team ${teamId} would go over its ${result.planName} limit for ${resource} (${result.used}+${adding}/${result.limit}); not enforced.`,
            );
        }

        if (!result.allowed) {
            res.status(402);
            res.json({
                error: incomingRefusal(result, adding),
                code: "plan_limit",
                resource,
                limit: result.limit,
                used: result.used,
                incoming: adding,
            });
            return false;
        }
    }

    return true;
}