/**
 * Signed, short-lived tickets for the web terminal. The API process signs
 * them and the channel process (a separate process) verifies them, so they
 * carry everything they need and share only TERMINAL_SECRET.
 *
 * A ticket is "<base64url payload>.<base64url hmac-sha256>" and is valid for
 * 30 seconds. Single use is enforced by the channel process via the nonce.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface TicketPayload {
    u: number; // user id
    s: number; // site id
    c: number; // terminal columns
    r: number; // terminal rows
    e: number; // expires at (ms since epoch)
    n: string; // nonce
}

const TTL_MS = 30_000;

function secret(): string {
    const value = process.env.TERMINAL_SECRET ?? "";
    if (value.length < 16) throw new Error("TERMINAL_SECRET is not set.");
    return value;
}

export function terminalConfigured(): boolean {
    return (process.env.TERMINAL_SECRET ?? "").length >= 16;
}

export function signTicket(userId: number, siteId: number, cols: number, rows: number): string {
    const payload: TicketPayload = {
        u: userId,
        s: siteId,
        c: cols,
        r: rows,
        e: Date.now() + TTL_MS,
        n: randomBytes(12).toString("hex"),
    };

    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", secret()).update(body).digest().toString("base64url");
    return `${body}.${sig}`;
}

/** Returns the payload for a valid, unexpired ticket, otherwise null. Never throws. */
export function verifyTicket(token: string): TicketPayload | null {
    try {
        const parts = token.split(".");
        if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

        const [body, sig] = parts;
        const expected = createHmac("sha256", secret()).update(body).digest();
        const given = Buffer.from(sig, "base64url");
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

        const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TicketPayload;
        const ints = [p.u, p.s, p.c, p.r, p.e].every((v) => Number.isInteger(v));
        if (!ints || typeof p.n !== "string" || p.e < Date.now()) return null;

        return p;
    } catch {
        return null;
    }
}