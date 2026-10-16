/**
 * Feature: Provider (hand-written validator)
 *
 * Keeps the validate${Model} naming convention (validateProvider).
 * The credential checks are deliberately loose (shape only): whether they
 * actually work is decided by calling the provider's API in the controller.
 *
 * Single-token providers send `api_token`. AWS sends `access_key_id` and
 * `secret_access_key`; credentialSecret() packs those into the JSON string the
 * AWS adapter expects (see services/AwsClient.ts).
 */

// AWS: accepted kind. The TOKEN regex already allows Vultr keys
// (36 uppercase letters and digits).
const KINDS = ["linode", "hetzner", "digitalocean", "vultr", "aws"];
const TOKEN = /^[A-Za-z0-9._-]{20,256}$/;

// AWS: long-term access keys. AKIA... is 20 characters, the secret is 40.
const AWS_KEY_ID = /^[A-Z0-9]{16,128}$/;
const AWS_SECRET = /^[A-Za-z0-9/+=]{30,100}$/;

/** Kinds whose credentials are several fields stored as JSON in providers.credentials. */
export const MULTI_FIELD_KINDS = ["aws"];

export interface NormalizedProvider {
    kind: string;
    label: string;
    api_token: string;
    access_key_id: string;
    secret_access_key: string;
}

export function normalizeProvider(data: Record<string, unknown>): NormalizedProvider {
    const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

    return {
        kind: str(data.kind).toLowerCase(),
        label: str(data.label),
        api_token: str(data.api_token),
        access_key_id: str(data.access_key_id),
        secret_access_key: str(data.secret_access_key),
    };
}

/**
 * The secret to verify and store for this kind, or "" when the request
 * carries none (an edit that only renames the connection).
 * Single-token providers: the token. AWS: the credentials JSON.
 */
export function credentialSecret(kind: string, input: NormalizedProvider): string {
    if (kind === "aws") {
        if (!input.access_key_id || !input.secret_access_key) return "";
        return JSON.stringify({
            access_key_id: input.access_key_id,
            secret_access_key: input.secret_access_key,
        });
    }
    return input.api_token;
}

export function validateProvider(
    data: Record<string, unknown>,
    // options.kind: the STORED kind, used on update (the body's kind is ignored there).
    options: { isUpdate?: boolean; kind?: string } = {},
) {
    const errors: Record<string, string[]> = {};
    const fail = (field: string, message: string) => {
        if (!errors[field]) errors[field] = [];
        errors[field].push(message);
    };

    const input = normalizeProvider(data ?? {});
    const kind = options.kind ?? input.kind;

    // The provider type is fixed once the connection exists.
    if (!options.isUpdate && !KINDS.includes(input.kind)) {
        fail("kind", "Choose a supported provider.");
    }

    if (!input.label) {
        fail("label", "Give this connection a name.");
    } else if (input.label.length > 60) {
        fail("label", "Name must be 60 characters or fewer.");
    }

    if (kind === "aws") {
        const hasId = Boolean(input.access_key_id);
        const hasSecret = Boolean(input.secret_access_key);
        const creating = !options.isUpdate;

        // On update both may be blank (keep the stored keys), but never just one.
        if (!hasId && (creating || hasSecret)) {
            fail("access_key_id", "Access key ID is required.");
        } else if (hasId && input.access_key_id.startsWith("ASIA")) {
            fail("access_key_id", "That is a temporary key (ASIA...). Use a long-term access key (AKIA...) from an IAM user.");
        } else if (hasId && !AWS_KEY_ID.test(input.access_key_id)) {
            fail("access_key_id", "That doesn't look like an access key ID. Paste it without spaces or quotes.");
        }

        if (!hasSecret && (creating || hasId)) {
            fail("secret_access_key", "Secret access key is required.");
        } else if (hasSecret && !AWS_SECRET.test(input.secret_access_key)) {
            fail("secret_access_key", "That doesn't look like a secret access key. Paste it without spaces or quotes.");
        }
    } else if (!input.api_token) {
        // On update the token is optional: omitting it keeps the stored one.
        if (!options.isUpdate) fail("api_token", "API token is required.");
    } else if (!TOKEN.test(input.api_token)) {
        fail("api_token", "That doesn't look like a valid token. Paste it without spaces or quotes.");
    }

    return { valid: Object.keys(errors).length === 0, errors };
}