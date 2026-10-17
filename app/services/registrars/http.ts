/**
 * Shared bits for the registrar adapters: one error type, one fetch helper,
 * and the record-name helpers (providers disagree on "@" vs "" vs the full name).
 */

export class RegistrarError extends Error {
    status: number;
    code: string;

    constructor(message: string, status: number, code = "") {
        super(message);
        this.name = "RegistrarError";
        this.status = status;
        this.code = code;
    }

    /** Bad key, revoked key, or the key lacks permission / the caller's IP isn't allowed. */
    get isAuth(): boolean {
        return this.status === 401 || this.status === 403;
    }

    /** Network failure, 5xx or rate limit. */
    get isTransient(): boolean {
        return this.status === 0 || this.status === 429 || this.status >= 500;
    }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

const TIMEOUT_MS = 20_000;

/** `data` is the body parsed as JSON ({} if it isn't JSON); `text` is the raw body (for XML). */
export async function http(url: string, init: RequestInit): Promise<{ status: number; data: Json; text: string }> {
    let res: Response;
    try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
        throw new RegistrarError("Could not reach the registrar.", 0);
    }

    const text = await res.text();
    let data: Json = {};
    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        /* non-JSON body */
    }
    return { status: res.status, data, text };
}

/** "www.example.com" in zone "example.com" -> "www"; the apex -> "@". */
export function relName(fqdn: string, domain: string): string {
    const n = fqdn.toLowerCase().replace(/\.$/, "");
    const d = domain.toLowerCase();
    if (n === d) return "@";
    return n.endsWith("." + d) ? n.slice(0, -(d.length + 1)) : n;
}

/** Reads a credentials JSON string into trimmed string fields. Throws if any listed field is missing. */
export function parseCreds<K extends string>(secret: string, keys: K[], label: string): Record<K, string> {
    let d: Record<string, unknown> | null = null;
    try {
        d = JSON.parse(secret);
    } catch {
        /* handled below */
    }

    const out = {} as Record<K, string>;
    for (const k of keys) {
        const v = typeof d?.[k] === "string" ? (d[k] as string).trim() : "";
        if (!v) throw new Error(`The stored ${label} credentials are incomplete.`);
        out[k] = v;
    }
    return out;
}

/** For registrars whose DNS records have no id: pack identifying parts into an opaque record id. */
export function encodeRef(parts: string[]): string {
    return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

export function decodeRef(id: string, length: number): string[] {
    try {
        const parts = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
        if (Array.isArray(parts) && parts.length === length) return parts.map(String);
    } catch {
        /* falls through */
    }
    throw new RegistrarError("That isn't a valid record reference.", 400, "BadReference");
}