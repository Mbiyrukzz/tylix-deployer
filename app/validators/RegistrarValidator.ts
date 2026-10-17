/**
 * Feature: Registrar (hand-written validator)
 *
 * Shape checks only. Whether the credentials work is decided by calling the
 * registrar's API in the controller (verify()).
 *
 *   Cloudflare: api_token (a single token, stored in registrars.api_token)
 *   Everything else is a set of fields stored as JSON in registrars.credentials:
 *     Porkbun    api_key, secret_key
 *     GoDaddy    api_key, api_secret
 *     Namecheap  api_user, api_key, client_ip (the server's whitelisted IPv4)
 *     Dynadot    api_key
 *     Name.com   api_user (username), api_token
 *     Spaceship  api_key, api_secret
 *     Route 53   api_key (access key ID), secret_key (secret access key)
 */

const KINDS = ["porkbun", "cloudflare", "godaddy", "namecheap", "dynadot", "namecom", "spaceship", "route53"];
const TOKEN = /^[A-Za-z0-9._-]{20,256}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Every credential slot a request may carry. */
const CRED_KEYS = ["api_token", "api_key", "secret_key", "api_secret", "api_user", "client_ip"] as const;
type CredKey = (typeof CRED_KEYS)[number];

export type NormalizedRegistrar = { kind: string; label: string } & Record<CredKey, string>;

interface CredField {
    key: CredKey;
    label: string;
    pattern?: RegExp;
    patternMessage?: string;
}

/** Kinds whose credentials are fields stored as JSON in registrars.credentials. */
const CRED_FIELDS: Record<string, CredField[]> = {
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
        { key: "client_ip", label: "Whitelisted IP", pattern: IPV4, patternMessage: "Enter this server's IPv4 address, like 203.0.113.10." },
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

export const MULTI_FIELD_KINDS = Object.keys(CRED_FIELDS);

export function normalizeRegistrar(data: Record<string, unknown>): NormalizedRegistrar {
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const out = { kind: str(data.kind).toLowerCase(), label: str(data.label) } as NormalizedRegistrar;
    for (const k of CRED_KEYS) out[k] = str(data[k]);
    return out;
}

/** The secret to verify and store, or "" when the request carries none (a rename-only edit). */
export function credentialSecret(kind: string, input: NormalizedRegistrar): string {
    const fields = CRED_FIELDS[kind];
    if (fields) {
        if (fields.some((f) => !input[f.key])) return "";
        return JSON.stringify(Object.fromEntries(fields.map((f) => [f.key, input[f.key]])));
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
        // On update all fields may be blank (keep the stored ones), but never just some.
        if (!options.isUpdate || anyFilled) {
            for (const f of fields) {
                if (!input[f.key]) fail(f.key, `${f.label} is required.`);
                else if (input[f.key].length > 256) fail(f.key, `${f.label} is too long.`);
                else if (f.pattern && !f.pattern.test(input[f.key])) fail(f.key, f.patternMessage ?? `${f.label} doesn't look right.`);
            }
        }
    } else if (!input.api_token) {
        if (!options.isUpdate) fail("api_token", "API token is required.");
    } else if (!TOKEN.test(input.api_token)) {
        fail("api_token", "That doesn't look like a valid token. Paste it without spaces or quotes.");
    }

    return { valid: Object.keys(errors).length === 0, errors };
}