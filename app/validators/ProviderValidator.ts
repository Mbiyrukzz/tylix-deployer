/**
 * Feature: Provider (hand-written validator)
 *
 * Keeps the validate${Model} naming convention (validateProvider).
 * The token check is deliberately loose (shape only): whether the token
 * actually works is decided by calling the provider's API in the controller.
 */

const KINDS = ["linode", "hetzner"];
const TOKEN = /^[A-Za-z0-9._-]{20,256}$/;

export interface NormalizedProvider {
    kind: string;
    label: string;
    api_token: string;
}

export function normalizeProvider(data: Record<string, unknown>): NormalizedProvider {
    const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

    return {
        kind: str(data.kind).toLowerCase(),
        label: str(data.label),
        api_token: str(data.api_token),
    };
}

export function validateProvider(
    data: Record<string, unknown>,
    options: { isUpdate?: boolean } = {},
) {
    const errors: Record<string, string[]> = {};
    const fail = (field: string, message: string) => {
        if (!errors[field]) errors[field] = [];
        errors[field].push(message);
    };

    const input = normalizeProvider(data ?? {});

    // The provider type is fixed once the connection exists.
    if (!options.isUpdate && !KINDS.includes(input.kind)) {
        fail("kind", "Choose a supported provider.");
    }

    if (!input.label) {
        fail("label", "Give this connection a name.");
    } else if (input.label.length > 60) {
        fail("label", "Name must be 60 characters or fewer.");
    }

    if (!input.api_token) {
        // On update the token is optional: omitting it keeps the stored one.
        if (!options.isUpdate) fail("api_token", "API token is required.");
    } else if (!TOKEN.test(input.api_token)) {
        fail("api_token", "That doesn't look like a valid token. Paste it without spaces or quotes.");
    }

    return { valid: Object.keys(errors).length === 0, errors };
}
