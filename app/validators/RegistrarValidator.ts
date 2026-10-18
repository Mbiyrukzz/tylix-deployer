/**
 * Feature: Registrar (hand-written validator)
 *
 * Shape checks only. Whether the credentials actually work is decided later,
 * when the controller calls the registrar's API (adapter.verify()).
 *
 * Every registrar now stores its credentials as a set of named fields, saved as
 * one encrypted JSON blob in registrars.credentials:
 *
 *   Cloudflare api_token, account_id, and optionally the R2 S3 credentials:
 *              r2_access_key_id, r2_secret_access_key, r2_endpoint
 *   Porkbun    api_key, secret_key
 *   GoDaddy    api_key, api_secret
 *   Namecheap  api_user, api_key, client_ip (the server's whitelisted IPv4)
 *   Dynadot    api_key
 *   Name.com   api_user (username), api_token
 *   Spaceship  api_key, api_secret
 *   Route 53   api_key (access key ID), secret_key (secret access key)
 *
 * Old Cloudflare rows kept a bare token in registrars.api_token. They keep
 * working (the adapter and registrarSecret() still read that), and they move
 * to the JSON format the next time the user pastes new credentials.
 */

const KINDS = ["porkbun", "cloudflare", "godaddy", "namecheap", "dynadot", "namecom", "spaceship", "route53"];

// Generic shape of an API token: letters, digits, dot, underscore, dash; 20-256 chars.
const TOKEN = /^[A-Za-z0-9._-]{20,256}$/;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

// A Cloudflare Account ID is 32 hex characters.
const ACCOUNT_ID = /^[a-f0-9]{32}$/i;

// R2's S3 endpoint: https://<account id>.r2.cloudflarestorage.com
// Jurisdiction endpoints add ".eu" or ".fedramp" before ".r2".
const R2_ENDPOINT = /^https:\/\/[a-f0-9]{32}(\.(eu|fedramp))?\.r2\.cloudflarestorage\.com\/?$/i;

/** Every credential slot a request body may carry. The form always sends all of them. */
const CRED_KEYS = [
    "api_token",
    "api_key",
    "secret_key",
    "api_secret",
    "api_user",
    "client_ip",
    // Cloudflare only
    "account_id",
    "r2_access_key_id",
    "r2_secret_access_key",
    "r2_endpoint",
] as const;
type CredKey = (typeof CRED_KEYS)[number];

export type NormalizedRegistrar = { kind: string; label: string } & Record<CredKey, string>;

interface CredField {
    /** Key in the request body AND in the stored JSON. */
    key: CredKey;
    /** Human name used in error messages. */
    label: string;
    /** Optional fields may stay blank. They are left out of the stored JSON when blank. */
    optional?: boolean;
    pattern?: RegExp;
    patternMessage?: string;
}

/** What each kind needs. Adding a registrar = one more entry here. */
const CRED_FIELDS: Record<string, CredField[]> = {
    cloudflare: [
        {
            key: "api_token",
            label: "API token",
            pattern: TOKEN,
            patternMessage: "That doesn't look like a valid token. Paste it without spaces or quotes.",
        },
        {
            key: "account_id",
            label: "Account ID",
            pattern: ACCOUNT_ID,
            patternMessage: "The Account ID is 32 letters and digits (a-f, 0-9).",
        },
        // R2 is optional. Nothing in the registrar features uses it yet; it is
        // stored so an R2 / object storage feature can use it later.
        { key: "r2_access_key_id", label: "Access Key ID", optional: true },
        { key: "r2_secret_access_key", label: "Secret Access Key", optional: true },
        {
            key: "r2_endpoint",
            label: "S3 API endpoint",
            optional: true,
            pattern: R2_ENDPOINT,
            patternMessage: "Use https://<account id>.r2.cloudflarestorage.com",
        },
    ],
    porkbun: [
        { key: "api_key", label: "API key" },
        { key: "secret_key", label: "Secret key" },
    ],
    godaddy: [
        { key: "api_key", label: "API key" },
        { key: "api_secret", label: "API secret" },
    ],
    namecheap: [
        { key: "api_user", label: "API user" },
        { key: "api_key", label: "API key" },
        {
            key: "client_ip",
            label: "Whitelisted IP",
            pattern: IPV4,
            patternMessage: "Enter this server's IPv4 address, like 203.0.113.10.",
        },
    ],
    dynadot: [{ key: "api_key", label: "API key" }],
    namecom: [
        { key: "api_user", label: "Username" },
        { key: "api_token", label: "API token" },
    ],
    spaceship: [
        { key: "api_key", label: "API key" },
        { key: "api_secret", label: "API secret" },
    ],
    route53: [
        { key: "api_key", label: "Access key ID" },
        { key: "secret_key", label: "Secret access key" },
    ],
};

/**
 * Kinds that store JSON in registrars.credentials. The controller's sealed()
 * uses this to pick the column. Cloudflare is now in here, so it is no longer
 * stored in api_token.
 */
export const MULTI_FIELD_KINDS = Object.keys(CRED_FIELDS);

/** Trims every value and makes sure all credential slots exist as strings. */
export function normalizeRegistrar(data: Record<string, unknown>): NormalizedRegistrar {
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const out = { kind: str(data.kind).toLowerCase(), label: str(data.label) } as NormalizedRegistrar;
    for (const k of CRED_KEYS) out[k] = str(data[k]);
    return out;
}

/**
 * The secret to verify and store, or "" when the request carries none
 * (a rename-only edit).
 *
 * - If any REQUIRED field is blank, the answer is "" (keep the stored credentials).
 *   validateRegistrar() has already rejected "some filled, some blank".
 * - Optional fields are included only when filled, so the stored JSON stays small
 *   and the adapter can test "is R2 configured" with a simple presence check.
 * - Kinds without a field list (none today) fall back to the single api_token.
 */
export function credentialSecret(kind: string, input: NormalizedRegistrar): string {
    const fields = CRED_FIELDS[kind];
    if (fields) {
        if (fields.some((f) => !f.optional && !input[f.key])) return "";
        return JSON.stringify(
            Object.fromEntries(fields.filter((f) => input[f.key]).map((f) => [f.key, input[f.key]])),
        );
    }
    return input.api_token;
}

export function validateRegistrar(
    data: Record<string, unknown>,
    // options.kind: the STORED kind, used on update (the body's kind is ignored there).
    options: { isUpdate?: boolean; kind?: string } = {},
) {
    const errors: Record<string, string[]> = {};
    const fail = (field: string, message: string) => {
        (errors[field] ??= []).push(message);
    };

    const input = normalizeRegistrar(data ?? {});
    const kind = options.kind ?? input.kind;

    if (!options.isUpdate && !KINDS.includes(input.kind)) fail("kind", "Choose a supported registrar.");

    if (!input.label) fail("label", "Give this connection a name.");
    else if (input.label.length > 60) fail("label", "Name must be 60 characters or fewer.");

    const fields = CRED_FIELDS[kind];
    if (fields) {
        const anyFilled = fields.some((f) => input[f.key]);

        // On update ALL fields may be blank (keep the stored ones), but as soon as
        // one is filled the whole set is checked again, because the credentials are
        // stored and verified together as one blob.
        if (!options.isUpdate || anyFilled) {
            for (const f of fields) {
                const value = input[f.key];

                if (!value) {
                    if (!f.optional) fail(f.key, `${f.label} is required.`);
                    continue; // blank optional field: nothing more to check
                }
                if (value.length > 256) fail(f.key, `${f.label} is too long.`);
                else if (f.pattern && !f.pattern.test(value)) {
                    fail(f.key, f.patternMessage ?? `${f.label} doesn't look right.`);
                }
            }

            // R2 keys only make sense as a pair: one half alone is a mistake.
            if (kind === "cloudflare") {
                if (input.r2_access_key_id && !input.r2_secret_access_key) {
                    fail("r2_secret_access_key", "Secret Access Key is required with the Access Key ID.");
                }
                if (input.r2_secret_access_key && !input.r2_access_key_id) {
                    fail("r2_access_key_id", "Access Key ID is required with the Secret Access Key.");
                }
            }
        }
    } else if (!input.api_token) {
        if (!options.isUpdate) fail("api_token", "API token is required.");
    } else if (!TOKEN.test(input.api_token)) {
        fail("api_token", "That doesn't look like a valid token. Paste it without spaces or quotes.");
    }

    return { valid: Object.keys(errors).length === 0, errors };
}