/**
 * Service: TwoFactorService
 *
 * TOTP (RFC 6238: SHA-1, 6 digits, 30 s) built on node:crypto, so no new
 * dependency is needed. Works with Google Authenticator, Authy, 1Password, etc.
 *
 *   - the secret is encrypted at rest (CryptoService) and never sent back
 *     after setup
 *   - a code is accepted once: last_step blocks replaying the same window
 *   - recovery codes are stored as SHA-256 hashes and each works once
 *   - challenge() is what the login flow calls
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { UserTwoFactor } from "../models/UserTwoFactor.js";
import { CryptoService } from "./CryptoService.js";

export interface TwoFactorRow {
    id: number;
    user_id: number;
    secret: string;
    confirmed_at: string | null;
    recovery_codes: string;
    last_step: number;
}

export type ChallengeResult = "not_enabled" | "missing" | "invalid" | "ok";

const ISSUER = "tylix-deploy";
const PERIOD_SECONDS = 30;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
    return out;
}

function base32Decode(text: string): Buffer {
    let bits = 0;
    let value = 0;
    const out: number[] = [];
    for (const ch of text.replace(/=+$/, "").toUpperCase()) {
        const idx = ALPHABET.indexOf(ch);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
}

function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

function totpAt(key: Buffer, step: number): string {
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(step));
    const hmac = createHmac("sha1", key).update(counter).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
        ((hmac[offset] & 0x7f) << 24) |
        (hmac[offset + 1] << 16) |
        (hmac[offset + 2] << 8) |
        hmac[offset + 3];
    return String(binary % 1_000_000).padStart(6, "0");
}

function normalizeRecovery(input: string): string {
    return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hashRecovery(input: string): string {
    return createHash("sha256").update(normalizeRecovery(input)).digest("hex");
}

function parseHashes(json: string | null | undefined): string[] {
    try {
        const list = JSON.parse(json || "[]");
        return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    } catch {
        return [];
    }
}

export class TwoFactorService {
    static async find(userId: number): Promise<TwoFactorRow | null> {
        return (await UserTwoFactor.query().where("user_id", userId).first()) as TwoFactorRow | null;
    }

    static async isEnabled(userId: number): Promise<boolean> {
        const row = await this.find(userId);
        return Boolean(row?.confirmed_at);
    }

    static generateSecret(): string {
        return base32Encode(randomBytes(20));
    }

    static uri(email: string, secret: string): string {
        const label = encodeURIComponent(`${ISSUER}:${email}`);
        return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=${PERIOD_SECONDS}`;
    }

    /** Returns the matched time-step, or null. Steps at or before `afterStep` are refused. */
    static verifyTotp(secret: string, code: string, afterStep = 0): number | null {
        const clean = code.replace(/\s/g, "");
        if (!/^\d{6}$/.test(clean)) return null;

        const key = base32Decode(secret);
        const now = Math.floor(Date.now() / 1000 / PERIOD_SECONDS);

        for (let step = now - 1; step <= now + 1; step++) {
            if (step <= afterStep) continue;
            if (safeEqual(totpAt(key, step), clean)) return step;
        }
        return null;
    }

    /** Ten-character codes shown as xxxxx-xxxxx. */
    static generateRecoveryCodes(): { plain: string[]; hashed: string[] } {
        const plain = Array.from({ length: 8 }, () => {
            const raw = randomBytes(5).toString("hex");
            return `${raw.slice(0, 5)}-${raw.slice(5)}`;
        });
        return { plain, hashed: plain.map(hashRecovery) };
    }

    static recoveryRemaining(row: TwoFactorRow): number {
        return parseHashes(row.recovery_codes).length;
    }

    /**
     * Login / sensitive-action check. Accepts an authenticator code or a
     * recovery code (which is burned on use).
     */
    static async challenge(userId: number, code: unknown): Promise<ChallengeResult> {
        const row = await this.find(userId);
        if (!row || !row.confirmed_at) return "not_enabled";

        const input = String(code ?? "").trim();
        if (!input) return "missing";

        const step = this.verifyTotp(CryptoService.decrypt(row.secret), input, Number(row.last_step) || 0);
        if (step !== null) {
            await UserTwoFactor.update(row.id, { last_step: step });
            return "ok";
        }

        const hashes = parseHashes(row.recovery_codes);
        const wanted = hashRecovery(input);
        const index = hashes.findIndex((h) => safeEqual(h, wanted));
        if (index !== -1) {
            hashes.splice(index, 1);
            await UserTwoFactor.update(row.id, { recovery_codes: JSON.stringify(hashes) });
            return "ok";
        }

        return "invalid";
    }
}