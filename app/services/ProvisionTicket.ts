/**
 * Short-lived ticket that lets a browser open the "provisionprogress" channel.
 * Sealed with CryptoService, so it can't be read or forged without the app key.
 */

import { CryptoService } from "./CryptoService.js";

export interface ProvisionTicketPayload {
    u: number; // user id
    p: number; // provision id
}

const TTL_MS = 60_000;

export function signProvisionTicket(userId: number, provisionId: number): string {
    return CryptoService.encrypt(
        JSON.stringify({ k: "provision", u: userId, p: provisionId, exp: Date.now() + TTL_MS }),
    );
}

export function verifyProvisionTicket(ticket: string): ProvisionTicketPayload | null {
    try {
        const data = JSON.parse(CryptoService.decrypt(ticket));
        if (data?.k !== "provision" || Number(data.exp) < Date.now()) return null;
        return { u: Number(data.u), p: Number(data.p) };
    } catch {
        return null;
    }
}