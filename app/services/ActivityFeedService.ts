/**
 * Service: ActivityFeedService
 *
 * The team's activity as people are allowed to see it:
 *
 *   TeamActivityService.collect()   everything members have added
 *   minus entries the team deleted  (activity_dismissals)
 *   minus entries past the plan's retention
 *
 * Retention by plan (change the numbers here, nowhere else):
 *   personal   the last 10 activities
 *   pro        the last 3 weeks
 *   business   the last 6 months
 *   legacy     no subscription row (accounts from before billing): kept until
 *              someone deletes it
 *   lapsed     kept as is. Nothing is hidden while a team can't act on it.
 *
 * "Auto-delete" is applied when the feed is read: older entries simply stop
 * appearing, so there is no job to run and nothing to go wrong overnight.
 * Because entries are derived from real rows, nothing real is removed.
 */

import { ActivityDismissal, type ActivityDismissalAttributes } from "../models/ActivityDismissal";
import { TeamActivityService, type ActivityEvent } from "./TeamActivityService.js";
import { entitlementFor } from "./EntitlementService.js";
import type { PlanId } from "./Plans.js";

export interface Retention {
    mode: "unlimited" | "count" | "days";
    value: number;
    label: string;
}

const PLAN_RETENTION: Record<PlanId, Retention> = {
    personal: { mode: "count", value: 10, label: "your last 10 activities" },
    pro: { mode: "days", value: 21, label: "the last 3 weeks" },
    business: { mode: "days", value: 180, label: "the last 6 months" },
};

export async function retentionFor(teamId: number): Promise<Retention> {
    const ent = await entitlementFor(teamId);

    if (ent.state === "active" && ent.plan && PLAN_RETENTION[ent.plan]) {
        return PLAN_RETENTION[ent.plan];
    }

    return {
        mode: "unlimited",
        value: 0,
        label: ent.state === "legacy" ? "everything, until you delete it" : "everything while your subscription is inactive",
    };
}

async function readDismissals(teamId: number): Promise<ActivityDismissalAttributes[]> {
    try {
        return (await ActivityDismissal.query().where("team_id", teamId).get()) as ActivityDismissalAttributes[];
    } catch (error) {
        console.error("[activity] couldn't read activity_dismissals (has the migration been run?):", error);
        return [];
    }
}

export const ActivityFeedService = {
    async forTeam(teamId: number): Promise<{ events: ActivityEvent[]; retention: Retention }> {
        const [all, rows, retention] = await Promise.all([
            TeamActivityService.collect(teamId),
            readDismissals(teamId),
            retentionFor(teamId),
        ]);

        const dismissed = new Set(rows.map((r) => String(r.event_id)));
        let events = all.filter((e) => !dismissed.has(e.id));

        if (retention.mode === "days") {
            const cutoff = new Date(Date.now() - retention.value * 86_400_000).toISOString();
            events = events.filter((e) => e.at >= cutoff);
        } else if (retention.mode === "count") {
            events = events.slice(0, retention.value);
        }

        return { events, retention };
    },

    /** Hides these entries from the team's feed. Safe to run twice. */
    async dismiss(teamId: number, actorId: number, eventIds: string[]): Promise<number> {
        const rows = (await ActivityDismissal.query().where("team_id", teamId).get()) as ActivityDismissalAttributes[];
        const have = new Set(rows.map((r) => String(r.event_id)));

        let added = 0;
        for (const id of eventIds) {
            if (have.has(id)) continue;
            await ActivityDismissal.create({ team_id: teamId, event_id: id, dismissed_by: actorId });
            have.add(id);
            added += 1;
        }

        return added;
    },
};