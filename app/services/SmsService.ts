/**
 * Service: SmsService
 *
 * Thin client for the Ashmif SMS API (POST /api/v3/sms/send).
 *
 * Env:
 *   ASHMIF_SMS_TOKEN      API token (sent as a Bearer token)
 *   ASHMIF_SMS_SENDER_ID  your approved sender ID (alphanumeric, max 11 chars)
 *   ASHMIF_SMS_URL        optional, defaults to the v3 send endpoint
 */

const DEFAULT_URL = "https://sms.ashmif.com/api/v3/sms/send";
const TIMEOUT_MS = 10_000;

export class SmsService {
    static isConfigured(): boolean {
        return Boolean(process.env.ASHMIF_SMS_TOKEN && process.env.ASHMIF_SMS_SENDER_ID);
    }

    /** `recipient` is digits with country code, e.g. 254712345678. */
    static async send(recipient: string, message: string): Promise<{ ok: boolean }> {
        if (!this.isConfigured()) return { ok: false };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const response = await fetch(process.env.ASHMIF_SMS_URL || DEFAULT_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${process.env.ASHMIF_SMS_TOKEN}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                body: JSON.stringify({
                    recipient,
                    sender_id: process.env.ASHMIF_SMS_SENDER_ID,
                    type: "plain",
                    message,
                }),
                signal: controller.signal,
            });

            const body = (await response.json().catch(() => null)) as
                | { status?: string; message?: string }
                | null;

            if (!response.ok || body?.status !== "success") {
                // Never log the message body: it contains the login code.
                console.error("SMS send failed:", response.status, body?.message ?? "no message");
                return { ok: false };
            }
            return { ok: true };
        } catch (err) {
            console.error("SMS send error:", err instanceof Error ? err.message : err);
            return { ok: false };
        } finally {
            clearTimeout(timer);
        }
    }
}