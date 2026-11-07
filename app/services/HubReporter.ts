/**
 * Pushes deploy events and heartbeats to the Hub. Fire-and-forget:
 * a Hub outage must never break or slow a deploy.
 */

const BASE = (process.env.HUB_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.HUB_API_KEY ?? "";

async function post(path: string, body: Record<string, unknown>): Promise<void> {
    if (!BASE || !KEY) return;
    try {
        await fetch(BASE + path, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(5000),
        });
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