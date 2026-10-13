/**
 * Feature: Provision (hand-written validator)
 *
 * Shape checks only. Whether the region, plan and image actually exist at
 * the provider is decided in the controller against the live catalog.
 */

export const TEMPLATES = ["tylix", "standard"];

const NAME = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

export interface NormalizedProvision {
    provider_id: number;
    name: string;
    region: string;
    plan: string;
    image: string;
    template: string;
}

export function normalizeProvision(data: Record<string, unknown>): NormalizedProvision {
    const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

    return {
        provider_id: Number(data.provider_id),
        name: str(data.name).toLowerCase(),
        region: str(data.region),
        plan: str(data.plan),
        image: str(data.image),
        template: str(data.template).toLowerCase(),
    };
}

export function validateProvision(data: Record<string, unknown>) {
    const errors: Record<string, string[]> = {};
    const fail = (field: string, message: string) => {
        if (!errors[field]) errors[field] = [];
        errors[field].push(message);
    };

    const input = normalizeProvision(data ?? {});

    if (!Number.isInteger(input.provider_id) || input.provider_id < 1) {
        fail("provider_id", "Choose a provider connection.");
    }
    if (!input.region) fail("region", "Choose a region.");
    if (!input.plan) fail("plan", "Choose a plan.");
    if (!input.image) fail("image", "Choose an operating system.");

    if (!NAME.test(input.name)) {
        fail("name", "Use 3-32 characters: lowercase letters, numbers and hyphens, starting and ending with a letter or number.");
    }

    if (!TEMPLATES.includes(input.template)) {
        fail("template", "Choose a template.");
    }

    return { valid: Object.keys(errors).length === 0, errors };
}
