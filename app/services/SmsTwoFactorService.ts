/**
 * Service: SmsTwoFactorService
 *
 * Text-message second factor. A 6-digit code is sent to the user's phone
 * through SmsService.
 *
 *   - codes are stored as SHA-256 hashes, expire after 5 minutes and work once
 *   - 5 wrong guesses kill the code
 *   - 60 s between sends, 5 sends per hour per user (SMS credits cost money)
 *   - the phone number is only changed by turning SMS off and setting it up again
 */

import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { UserSmsTwoFactor } from "../models/UserSmsTwoFactor.js";
import { SmsService } from "./SmsService.js";

export interface SmsFactorRow {
    id: number;
    user_id: number;
    phone: string;
    confirmed_at: string | null;
    code_hash: string | null;
    code_expires_at: string | null;
    code_attempts: number;
    last_sent_at: string | null;
    send_window_started_at: string | null;
    send_count: number;
}

export type SendResult =
    | { ok: true }
    | {
          ok: false;
          reason: "cooldown" | "limit" | "provider" | "not_configured";
          message: string;
          /** cooldown only: a still-valid code is already on its way */
          pending?: boolean;
          retryAfterSeconds?: number;
      };

const CODE_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;

function hashCode(rowId: number, code: string): string {
    return createHash("sha256").update(`${rowId}:${code}`).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

function time(value: string | null | undefined): number {
    if (!value) return 0;
    const s = String(value).trim();
    // The database returns "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
    // Without the "Z", JavaScript would read it as local time.
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? s.replace(" ", "T") + "Z" : s;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? 0 : t;
}

export class SmsTwoFactorService {
    static async find(userId: number): Promise<SmsFactorRow | null> {
        return (await UserSmsTwoFactor.query().where("user_id", userId).first()) as SmsFactorRow | null;
    }

    static async summary(userId: number): Promise<{ enabled: boolean; phone_hint: string | null }> {
        const row = await this.find(userId);
        const enabled = Boolean(row?.confirmed_at);
        return { enabled, phone_hint: enabled && row ? this.maskPhone(row.phone) : null };
    }

    /**
     * Digits only, with country code. Accepts 0712345678, 254712345678,
     * +254 712 345 678, 00254712345678 and other international numbers.
     */
    static normalizePhone(input: unknown): string | null {
        let digits = String(input ?? "").replace(/[\s\-().]/g, "");
        if (digits.startsWith("+")) digits = digits.slice(1);
        else if (digits.startsWith("00")) digits = digits.slice(2);
        else if (/^0\d{9}$/.test(digits)) digits = "254" + digits.slice(1);
        return /^[1-9]\d{9,14}$/.test(digits) ? digits : null;
    }

    /** 254712345678 -> +254•••••678 */
    static maskPhone(phone: string): string {
        if (phone.length < 7) return "your phone";
        return `+${phone.slice(0, 3)}${"•".repeat(phone.length - 6)}${phone.slice(-3)}`;
    }

    /** Create or reset the row for a fresh setup. The number is not trusted until confirmed. */
    static async prepare(userId: number, phone: string): Promise<SmsFactorRow> {
        const fresh = {
            phone,
            confirmed_at: null,
            code_hash: null,
            code_expires_at: null,
            code_attempts: 0,
        };
        const existing = await this.find(userId);
        if (existing) {
            await UserSmsTwoFactor.update(existing.id, fresh);
        } else {
            await UserSmsTwoFactor.create({
                user_id: userId,
                ...fresh,
                last_sent_at: null,
                send_window_started_at: null,
                send_count: 0,
            });
        }
        return (await this.find(userId)) as SmsFactorRow;
    }

    static async markConfirmed(rowId: number) {
        return UserSmsTwoFactor.update(rowId, {
            confirmed_at: new Date().toISOString(),
            code_hash: null,
            code_expires_at: null,
            code_attempts: 0,
        });
    }

    /** Turn SMS off. Send counters are kept so on/off toggling can't dodge the hourly cap. */
    static async reset(rowId: number) {
        return UserSmsTwoFactor.update(rowId, {
            phone: "",
            confirmed_at: null,
            code_hash: null,
            code_expires_at: null,
            code_attempts: 0,
        });
    }

    static async sendCode(row: SmsFactorRow): Promise<SendResult> {
        if (!SmsService.isConfigured()) {
            return { ok: false, reason: "not_configured", message: "Text-message codes aren't set up on this server." };
        }

        const now = Date.now();

        const cooldownLeft = RESEND_COOLDOWN_MS - (now - time(row.last_sent_at));
        if (row.last_sent_at && cooldownLeft > 0) {
            const seconds = Math.ceil(cooldownLeft / 1000);
            return {
                ok: false,
                reason: "cooldown",
                pending: Boolean(row.code_hash) && time(row.code_expires_at) > now,
                retryAfterSeconds: seconds,
                message: `Wait ${seconds} seconds before asking for another code.`,
            };
        }

        let windowStart = time(row.send_window_started_at);
        let count = Number(row.send_count) || 0;
        if (!windowStart || now - windowStart > HOUR_MS) {
            windowStart = now;
            count = 0;
        }
        if (count >= MAX_SENDS_PER_HOUR) {
            const minutes = Math.ceil((windowStart + HOUR_MS - now) / 60_000);
            return {
                ok: false,
                reason: "limit",
                retryAfterSeconds: minutes * 60,
                message: `Too many codes requested. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
            };
        }

        const code = String(randomInt(0, 1_000_000)).padStart(6, "0");

        // Saved before sending so a very fast reply can't beat the write.
        await UserSmsTwoFactor.update(row.id, {
            code_hash: hashCode(row.id, code),
            code_expires_at: new Date(now + CODE_TTL_MS).toISOString(),
            code_attempts: 0,
            last_sent_at: new Date(now).toISOString(),
            send_window_started_at: new Date(windowStart).toISOString(),
            send_count: count + 1,
        });

        const sent = await SmsService.send(
            row.phone,
            `Your Tylix Deploy login code is ${code}. It expires in 5 minutes. Never share it.`,
        );

        if (!sent.ok) {
            await UserSmsTwoFactor.update(row.id, { code_hash: null, code_expires_at: null });
            return { ok: false, reason: "provider", message: "We couldn't send the text. Try again in a moment." };
        }

        return { ok: true };
    }

    /** True once, for the right unexpired code. */
    // TEMPORARY: replace verifyCode() in SmsTwoFactorService.ts with this, try once, read the server log.
// It logs WHY a code was refused. It never logs the code or the hash.

static async verifyCode(row: SmsFactorRow, input: string): Promise<boolean> {
    const clean = input.replace(/\s/g, "");
    const now = Date.now();
    const expires = time(row.code_expires_at);
    const attempts = Number(row.code_attempts) || 0;

    const why = !/^\d{6}$/.test(clean)
        ? "input is not 6 digits"
        : !row.code_hash
          ? "no pending code stored (hash empty)"
          : !row.code_expires_at || Number.isNaN(expires)
            ? `expiry unreadable: ${JSON.stringify(row.code_expires_at)}`
            : expires < now
              ? `expired ${Math.round((now - expires) / 1000)}s ago (stored ${row.code_expires_at})`
              : attempts >= MAX_ATTEMPTS
                ? `attempt limit reached (${attempts})`
                : !safeEqual(row.code_hash, hashCode(row.id, clean))
                  ? "code does not match the latest one sent"
                  : null;

    if (why) {
        console.warn("SMS code refused:", why);
        if (why === "code does not match the latest one sent") {
            await UserSmsTwoFactor.update(row.id, { code_attempts: attempts + 1 });
        }
        return false;
    }

    await UserSmsTwoFactor.update(row.id, { code_hash: null, code_expires_at: null, code_attempts: 0 });
    return true;
}
}