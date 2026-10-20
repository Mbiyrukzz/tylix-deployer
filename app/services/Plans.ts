/**
 * The plan catalog. Plans are code, not database rows, so a price or limit
 * change is a normal deploy. A limit of null means unlimited.
 *
 * Paystack plan codes are added in the billing step (they will come from env).
 */

export type PlanId = "personal" | "pro" | "business";
export type Resource = "members" | "servers" | "sites" | "providers";
export type Limits = Record<Resource, number | null>;

export interface PlanDef {
    id: PlanId;
    name: string;
    priceUsd: number;
    limits: Limits;
}

export const PLANS: PlanDef[] = [
    {
        id: "personal",
        name: "Personal",
        priceUsd: 10,
        limits: { members: 1, servers: 3, sites: 10, providers: 2 },
    },
    {
        id: "pro",
        name: "Pro",
        priceUsd: 20,
        limits: { members: 5, servers: 10, sites: 50, providers: 5 },
    },
    {
        id: "business",
        name: "Business",
        priceUsd: 49,
        limits: { members: 15, servers: 30, sites: null, providers: null },
    },
];

/** Teams with no subscription row yet (everyone who existed before billing). */
export const LEGACY_LIMITS: Limits = { members: null, servers: null, sites: null, providers: null };

/** Teams whose subscription ended: existing things keep running, nothing new can be added. */
export const LAPSED_LIMITS: Limits = { members: 0, servers: 0, sites: 0, providers: 0 };

export const RESOURCE_LABELS: Record<Resource, string> = {
    members: "team members",
    servers: "servers",
    sites: "sites",
    providers: "provider connections",
};

export function getPlanDef(id: string): PlanDef | undefined {
    return PLANS.find((p) => p.id === id);
}