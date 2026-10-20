import { createHmac, timingSafeEqual } from "node:crypto";

const BASE = "https://api.paystack.co";

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) throw new Error("PAYSTACK_SECRET_KEY is not set.");

    const response = await fetch(BASE + path, {
        method,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    });

    const json = (await response.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (!response.ok || !json.status) {
        throw new Error(json.message || `Paystack answered ${response.status}`);
    }
    return json.data as T;
}

export const PaystackService = {
    /** The plan's own amount and currency are used; amount is only a required placeholder. */
    initialize: (input: { email: string; plan: string; reference: string; callbackUrl: string; metadata: Record<string, unknown> }) =>
        call<{ authorization_url: string; reference: string }>("POST", "/transaction/initialize", {
            email: input.email,
            amount: 100,
            currency: process.env.PAYSTACK_CURRENCY || "KES",
            plan: input.plan,
            reference: input.reference,
            callback_url: input.callbackUrl,
            metadata: input.metadata,
        }),

    verify: (reference: string) =>
        call<{
            status: string;
            reference: string;
            customer: { customer_code: string; email: string };
            metadata: { team_id?: number; plan?: string } | null;
        }>("GET", `/transaction/verify/${encodeURIComponent(reference)}`),

    disable: (code: string, token: string) =>
        call<unknown>("POST", "/subscription/disable", { code, token }),

    /** Paystack signs the raw request body with HMAC SHA512 using the secret key. */
    validSignature(raw: string, signature: string): boolean {
        const key = process.env.PAYSTACK_SECRET_KEY;
        if (!key || !signature) return false;

        const expected = createHmac("sha512", key).update(raw).digest("hex");
        const a = Buffer.from(expected);
        const b = Buffer.from(signature);
        return a.length === b.length && timingSafeEqual(a, b);
    },
};