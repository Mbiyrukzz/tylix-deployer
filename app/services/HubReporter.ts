/**
 * Pushes deploy events, heartbeats and user numbers to the Hub.
 * Fire-and-forget: a Hub outage must never break or slow a deploy.
 */

const BASE = (process.env.HUB_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.HUB_API_KEY ?? "";

export interface UserMetrics {
    users_total: number;
    users_active: number;
    active_days: number;
}

// One warning per path until it works again, so a wrong key or URL shows up
// in the log without flooding it every minute.
const warned = new Set<string>();

async function post(path: string, body: Record<string, unknown>): Promise<void> {
    if (!BASE || !KEY) return;
    try {
        const res = await fetch(BASE + path, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });

        if (res.ok) {
            warned.delete(path);
        } else if (!warned.has(path)) {
            warned.add(path);
            console.warn(`Hub ${path} answered ${res.status}. Check HUB_URL and HUB_API_KEY.`);
        }
    } catch {
        // Swallowed on purpose.
    }
}

export function reportEvent(type: string, message = "", meta: Record<string, unknown> = {}): void {
    void post("/api/v1/ingest/events", { type, message, meta, at: new Date().toISOString() });
}

export function startHeartbeat(version: string): void {
    if (!BASE || !KEY) return;
    const beat = () => void post("/api/v1/ingest/heartbeat", { version });
    beat();
    setInterval(beat, 60_000).unref();
}

/**
 * Reports user numbers every ten minutes, first after a short delay so
 * boot isn't slowed down. A failure to count never stops the timer.
 */
export function startMetrics(collect: () => Promise<UserMetrics>): void {
    if (!BASE || !KEY) return;

    const send = async () => {
        try {
            const metrics = await collect();
            await post("/api/v1/ingest/metrics", { ...metrics });
        } catch (err) {
            console.error("Hub metrics could not be collected:", err);
        }
    };

    setTimeout(() => void send(), 30_000).unref();
    setInterval(() => void send(), 10 * 60_000).unref();
}