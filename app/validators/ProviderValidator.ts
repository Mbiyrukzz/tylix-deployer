/**
 * Feature: Provider (hand-written validator)
 *
 * Keeps the validate${Model} naming convention (validateProvider).
 * The credential checks are deliberately loose (shape only): whether they
 * actually work is decided by calling the provider's API in the controller.
 *
 * Single-token providers send `api_token`. Multi-field providers send several
 * fields and credentialSecret() packs them into the JSON string their adapter expects:
 *   AWS:      access_key_id, secret_access_key       (services/AwsClient.ts)
 *   UpCloud:  username, password                     (services/UpCloudClient.ts)
 *   Contabo:  client_id, client_secret, api_user, api_password (services/ContaboClient.ts)
 */

const KINDS = ["linode", "hetzner", "digitalocean", "vultr", "aws", "upcloud", "contabo"];
const TOKEN = /^[A-Za-z0-9._-]{20,256}$/;

// AWS: long-term access keys. AKIA... is 20 characters, the secret is 40.
const AWS_KEY_ID = /^[A-Z0-9]{16,128}$/;
const AWS_SECRET = /^[A-Za-z0-9/+=]{30,100}$/;

/** Kinds whose credentials are several fields stored as JSON in providers.credentials. */
export const MULTI_FIELD_KINDS = ["aws", "upcloud", "contabo"];

export interface NormalizedProvider {
    kind: string;
    label: string;
    api_token: string;
    access_key_id: string;
    secret_access_key: string;
    username: string;
    password: string;
    client_id: string;
    client_secret: string;
    api_user: string;
    api_password: string;
}

/** The plain "all fields required" kinds. AWS has its own, stricter checks below. */
const CRED_FIELDS: Record<string, { key: keyof NormalizedProvider; label: string }[]> = {
    upcloud: [
        { key: "username", label: "API username" },
        { key: "password", label: "API password" },
    ],
    contabo: [
        { key: "client_id", label: "Client ID" },
        { key: "client_secret", label: "Client secret" },
        { key: "api_user", label: "API user" },
        { key: "api_password", label: "API password" },
    ],
};

export function normalizeProvider(data: Record<string, unknown>): NormalizedProvider {
    const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

    return {
        kind: str(data.kind).toLowerCase(),
        label: str(data.label),
        api_token: str(data.api_token),
        access_key_id: str(data.access_key_id),
        secret_access_key: str(data.secret_access_key),
        username: str(data.username),
        password: str(data.password),
        client_id: str(data.client_id),
        client_secret: str(data.client_secret),
        api_user: str(data.api_user),
        api_password: str(data.api_password),
    };
}

/**
 * The secret to verify and store for this kind, or "" when the request
 * carries none (an edit that only renames the connection).
 * Single-token providers: the token. Multi-field providers: the credentials JSON.
 */
export function credentialSecret(kind: string, input: NormalizedProvider): string {
    if (kind === "aws") {
        if (!input.access_key_id || !input.secret_access_key) return "";
        return JSON.stringify({
            access_key_id: input.access_key_id,
            secret_access_key: input.secret_access_key,
        });
    }

    const fields = CRED_FIELDS[kind];
    if (fields) {
        if (fields.some((f) => !input[f.key])) return "";
        return JSON.stringify(Object.fromEntries(fields.map((f) => [f.key, input[f.key]])));
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
    } else if (CRED_FIELDS[kind]) {
        const fields = CRED_FIELDS[kind];
        const anyFilled = fields.some((f) => input[f.key]);

        // On update all fields may be blank (keep the stored credentials), but never just some.
        if (!options.isUpdate || anyFilled) {
            for (const f of fields) {
                if (!input[f.key]) fail(f.key, `${f.label} is required.`);
                else if (input[f.key].length > 256) fail(f.key, `${f.label} is too long.`);
            }
        }
    } else if (!input.api_token) {
        // On update the token is optional: omitting it keeps the stored one.
        if (!options.isUpdate) fail("api_token", "API token is required.");
    } else if (!TOKEN.test(input.api_token)) {
        fail("api_token", "That doesn't look like a valid token. Paste it without spaces or quotes.");
    }

    return { valid: Object.keys(errors).length === 0, errors };
}