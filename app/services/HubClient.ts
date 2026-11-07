/**
 * Reads this product's changelog from the Ashmif Hub public API.
 * Server-side only, so there is no CORS to deal with. Results are cached
 * for a minute, and the last good copy is served if the Hub is unreachable.
 */

const BASE = (process.env.HUB_URL ?? "").replace(/\/+$/, "");
const SLUG = process.env.HUB_PRODUCT_SLUG ?? "tylix-deploy";
const TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;

export interface HubEntry {
    version: string;
    title: string;
    body: string;
    category: string;
    published_at: string;
}

export interface ChangelogResult {
    ok: boolean;
    entries: HubEntry[];
    stale?: boolean;
    error?: string;
}

let cache: { at: number; entries: HubEntry[] } | null = null;

export async function getChangelog(): Promise<ChangelogResult> {
    if (!BASE) {
        return { ok: false, entries: [], error: "HUB_URL is not set." };
    }

    if (cache && Date.now() - cache.at < TTL_MS) {
        return { ok: true, entries: cache.entries };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(
            `${BASE}/api/v1/products/${encodeURIComponent(SLUG)}/changelog?limit=50`,
            { headers: { Accept: "application/json" }, signal: controller.signal },
        );
        if (!res.ok) throw new Error(`The Hub answered ${res.status}.`);

        const json = (await res.json()) as { data?: HubEntry[] };
        const entries = Array.isArray(json.data) ? json.data : [];
        cache = { at: Date.now(), entries };
        return { ok: true, entries };
    } catch (err) {
        // Hub down or slow: show the last good copy rather than nothing.
        if (cache) return { ok: true, entries: cache.entries, stale: true };
        return { ok: false, entries: [], error: "Could not reach the Hub." };
    } finally {
        clearTimeout(timer);
    }
}

export interface StatusResult {
    state: "operational" | "outage" | "unknown";
    last_seen_at: string | null;
}

const STATUS_TTL_MS = 30_000;
let statusCache: { at: number; value: StatusResult } | null = null;

/** Never throws. If the Hub can't be reached the answer is "unknown", never a stale "operational". */
export async function getStatus(): Promise<StatusResult> {
    const unknown: StatusResult = { state: "unknown", last_seen_at: null };
    if (!BASE) return unknown;

    if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
        return statusCache.value;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(`${BASE}/api/v1/products/${encodeURIComponent(SLUG)}/status`, {
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!res.ok) return unknown;

        const json = (await res.json()) as { status?: { state?: string; last_seen_at?: string | null } };
        const state = json.status?.state;
        if (state !== "operational" && state !== "outage" && state !== "unknown") return unknown;

        const value: StatusResult = { state, last_seen_at: json.status?.last_seen_at ?? null };
        statusCache = { at: Date.now(), value };
        return value;
    } catch {
        return unknown;
    } finally {
        clearTimeout(timer);
    }
}