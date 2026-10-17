/**
 * Feature: Provider DNS (hand-written validator)
 *
 * Shape checks only. Whether the provider accepts the record is decided by
 * its API, and its message is passed back to the form.
 */

export const RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"];
export const CAA_TAGS = ["issue", "issuewild", "iodef"];
export const SRV_PROTOCOLS = ["tcp", "udp", "tls"];
/** TTLs Linode accepts for a domain (0 = its default). */
export const DOMAIN_TTLS = [0, 300, 3600, 7200, 14400, 28800, 57600, 86400, 172800, 345600, 604800, 1209600, 2419200];

const SERVICE = /^[a-z0-9-]{1,63}$/;

const DOMAIN =
    /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LABEL = /^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_.-]*[a-z0-9_])?)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOST = /^[A-Za-z0-9_*][A-Za-z0-9_.*-]*\.?$/;

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function collect() {
    const errors: Record<string, string[]> = {};
    const fail = (field: string, message: string) => {
        if (!errors[field]) errors[field] = [];
        errors[field].push(message);
    };
    return { errors, fail };
}

// ---- Domains ----

export interface NormalizedDomain {
    name: string;
    email: string;
}

export function normalizeDomain(data: Record<string, unknown>): NormalizedDomain {
    return {
        name: str(data.name).toLowerCase().replace(/\.$/, ""),
        email: str(data.email),
    };
}

export function validateDomain(data: Record<string, unknown>) {
    const { errors, fail } = collect();
    const input = normalizeDomain(data ?? {});

    if (!input.name) fail("name", "Enter a domain name.");
    else if (!DOMAIN.test(input.name)) fail("name", "Enter a domain like example.com, without http:// or a path.");

    if (input.email && !EMAIL.test(input.email)) fail("email", "Enter a valid email address.");

    return { valid: Object.keys(errors).length === 0, errors };
}

// ---- Domain settings ----

export interface NormalizedDomainSettings {
    email: string;
    ttl: number;
}

export function normalizeDomainSettings(data: Record<string, unknown>): NormalizedDomainSettings {
    const raw = data?.ttl;
    return {
        email: str(data?.email),
        ttl: raw === undefined || raw === null || raw === "" ? 0 : Number(raw),
    };
}

export function validateDomainSettings(data: Record<string, unknown>) {
    const { errors, fail } = collect();
    const input = normalizeDomainSettings(data ?? {});

    if (!input.email) fail("email", "Enter the email address for the domain's SOA record.");
    else if (!EMAIL.test(input.email)) fail("email", "Enter a valid email address.");

    if (!DOMAIN_TTLS.includes(input.ttl)) fail("ttl", "Choose a TTL.");

    return { valid: Object.keys(errors).length === 0, errors };
}

// ---- Records ----

export interface NormalizedRecord {
    type: string;
    name: string;
    value: string;
    ttl: number;
    priority: number | null;
    weight: number | null;
    port: number | null;
    service: string;
    protocol: string;
    tag: string;
}

export function normalizeRecord(data: Record<string, unknown>): NormalizedRecord {
    const type = str(data.type).toUpperCase();

    let name = str(data.name).toLowerCase();
    if (name === "") name = "@";

    const num = (v: unknown, fallback: number) =>
        v === undefined || v === null || v === "" ? fallback : Number(v);

    let value = str(data.value);
    if (type === "CAA") value = value.replace(/^"|"$/g, "");

    return {
        type,
        name,
        value,
        ttl: num(data.ttl, 0),
        priority: type === "MX" || type === "SRV" ? num(data.priority, 10) : null,
        weight: type === "SRV" ? num(data.weight, 0) : null,
        port: type === "SRV" ? num(data.port, 0) : null,
        service: type === "SRV" ? str(data.service).toLowerCase().replace(/^_+/, "") : "",
        protocol: type === "SRV" ? str(data.protocol).toLowerCase().replace(/^_+/, "") || "tcp" : "",
        tag: type === "CAA" ? str(data.tag).toLowerCase() || "issue" : "",
    };
}

export function validateRecord(data: Record<string, unknown>) {
    const { errors, fail } = collect();
    const input = normalizeRecord(data ?? {});
    const whole = (n: number | null, max: number) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;

    if (!RECORD_TYPES.includes(input.type)) fail("type", "Choose a record type.");

    if (input.type !== "SRV" && !LABEL.test(input.name)) {
        fail("name", "Use @ for the root, or a name like www or mail.app. Letters, numbers, hyphens and dots only.");
    }

    if (!input.value) {
        fail("value", "Enter a value.");
    } else if (input.type === "A" && !IPV4.test(input.value)) {
        fail("value", "Enter an IPv4 address like 203.0.113.10.");
    } else if (input.type === "AAAA" && !(input.value.includes(":") && /^[0-9a-f:.]+$/i.test(input.value))) {
        fail("value", "Enter an IPv6 address like 2001:db8::1.");
    } else if (["CNAME", "MX", "NS", "SRV"].includes(input.type) && !HOST.test(input.value)) {
        fail("value", "Enter a hostname like mail.example.com.");
    } else if (input.type === "CAA" && (input.value.length > 255 || /\s/.test(input.value))) {
        fail("value", "Enter a value like letsencrypt.org, with no spaces.");
    } else if (input.type === "TXT" && input.value.length > 2000) {
        fail("value", "That value is too long.");
    }

    if ((input.type === "MX" || input.type === "SRV") && !whole(input.priority, 65535)) {
        fail("priority", "Priority must be a whole number between 0 and 65535.");
    }

    if (input.type === "SRV") {
        if (!SERVICE.test(input.service)) fail("service", "Enter a service name like sip or xmpp-server.");
        if (!SRV_PROTOCOLS.includes(input.protocol)) fail("protocol", "Choose tcp, udp or tls.");
        if (!whole(input.weight, 65535)) fail("weight", "Weight must be a whole number between 0 and 65535.");
        if (!whole(input.port, 65535)) fail("port", "Port must be a whole number between 0 and 65535.");
    }

    if (input.type === "CAA" && !CAA_TAGS.includes(input.tag)) {
        fail("tag", "Choose issue, issuewild or iodef.");
    }

    if (!Number.isInteger(input.ttl) || (input.ttl !== 0 && (input.ttl < 30 || input.ttl > 2592000))) {
        fail("ttl", "Choose a TTL.");
    }

    return { valid: Object.keys(errors).length === 0, errors };
}