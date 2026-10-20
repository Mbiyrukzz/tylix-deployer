/**
 * Signed 30-second ticket for the "serverstats" channel.
 *
 * Signed with TERMINAL_SECRET, but the HMAC input is prefixed with "stats."
 * so a terminal ticket can never be replayed here (or the other way round).
 * Read-only: any team member may get one for their team's server.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const TTL_MS = 30_000;

export interface StatsTicketPayload {
    u: number; // user id
    v: number; // server id
    e: number; // expires at (ms)
    k: "stats";
}

function secret(): string {
    const value = process.env.TERMINAL_SECRET;
    if (!value) throw new Error("TERMINAL_SECRET is not set.");
    return value;
}

function mac(body: string, key: string): string {
    return createHmac("sha256", key).update("stats." + body).digest("base64url");
}

export function signStatsTicket(userId: number, serverId: number): string {
    const payload: StatsTicketPayload = { u: userId, v: serverId, e: Date.now() + TTL_MS, k: "stats" };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return body + "." + mac(body, secret());
}

export function verifyStatsTicket(token: string): StatsTicketPayload | null {
    try {
        const [body, sig] = token.split(".");
        if (!body || !sig) return null;

        const expected = Buffer.from(mac(body, secret()));
        const given = Buffer.from(sig);
        if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

        const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatsTicketPayload;
        if (payload.k !== "stats") return null;
        if (!Number.isInteger(payload.u) || !Number.isInteger(payload.v)) return null;
        if (typeof payload.e !== "number" || payload.e < Date.now()) return null;

        return payload;
    } catch {
        return null;
    }
}