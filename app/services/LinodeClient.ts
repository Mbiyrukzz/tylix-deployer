/**
 * Minimal Linode (Akamai) API v4 client. No third-party dependencies:
 * it uses Node's built-in fetch.
 *
 * Catalog endpoints (regions, plans, images) are public and need no token.
 * Everything that touches an account needs a personal access token with
 * the "Linodes: Read/Write" scope.
 *
 * Billing (getAccount, listInvoices, listPaymentMethods, makePayment) also needs
 * the "Account" scope: Read Only to look, Read/Write to make a payment.
 * Paying with a credit card also needs the card's CVV; Google Pay and PayPal don't.
 */

import { randomBytes } from "node:crypto";

const API_BASE = "https://api.linode.com/v4";
const TIMEOUT_MS = 20_000;

/** Images the provisioning scripts support (apt-based distributions). */
const SUPPORTED_IMAGES: Record<string, string> = {
    "linode/ubuntu24.04": "Ubuntu 24.04 LTS",
    "linode/ubuntu22.04": "Ubuntu 22.04 LTS",
    "linode/debian12": "Debian 12",
};

export interface LinodeRegion {
    id: string;
    label: string;
    country: string;
}

export interface LinodePlan {
    id: string;
    label: string;
    class: string;
    memory_mb: number;
    vcpus: number;
    disk_gb: number;
    monthly: number;
    hourly: number;
}

export interface LinodeImage {
    id: string;
    label: string;
}

export interface LinodeInstance {
    id: number;
    label: string;
    status: string;
    region: string;
    type: string;
    ipv4: string[];
    tags: string[];
}

export interface CreateInstanceInput {
    region: string;
    type: string;
    image: string;
    label: string;
    rootPassword: string;
    authorizedKeys: string[];
    tags?: string[];
}

// ---- Billing types ----

export interface LinodeAccount {
    /** USD. Positive means money is owed, negative means credit on the account. */
    balance: number;
    /** USD charged so far this month that is not on an invoice yet. */
    balanceUninvoiced: number;
    billingSource: string;
}

export interface LinodeInvoice {
    id: number;
    date: string;
    label: string;
    total: number;
}

export interface LinodePaymentMethod {
    id: number;
    /** "credit_card", "google_pay" or "paypal". */
    type: string;
    isDefault: boolean;
    cardType: string;
    lastFour: string;
}

export interface LinodePayment {
    id: number;
    date: string;
    usd: number;
}

export class LinodeError extends Error {
    status: number;
    reasons: { field?: string; reason: string }[];

    constructor(message: string, status: number, reasons: { field?: string; reason: string }[] = []) {
        super(message);
        this.name = "LinodeError";
        this.status = status;
        this.reasons = reasons;
    }
}

interface RawInstance {
    id: number;
    label: string;
    status: string;
    region: string;
    type: string;
    ipv4: string[];
    tags: string[];
}

interface RawInvoice {
    id: number;
    date?: string;
    label?: string;
    total?: number | string;
}

interface RawPaymentMethod {
    id: number;
    type?: string;
    is_default?: boolean;
    data?: { card_type?: string; last_four?: string };
}

function toInstance(raw: RawInstance): LinodeInstance {
    return {
        id: raw.id,
        label: raw.label,
        status: raw.status,
        region: raw.region,
        type: raw.type,
        ipv4: raw.ipv4 ?? [],
        tags: raw.tags ?? [],
    };
}

async function request<T>(
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
): Promise<T> {
    const headers: Record<string, string> = { Accept: "application/json", ...extraHeaders };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
        response = await fetch(`${API_BASE}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        // Never include the request details here: they carry the token (and, for a payment, the CVV).
        throw new LinodeError("Could not reach the Linode API.", 0);
    }

    const text = await response.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // Non-JSON body: fall through with json = null.
    }

    if (!response.ok) {
        const errors = (json as { errors?: { field?: string; reason: string }[] } | null)?.errors;
        const reasons = Array.isArray(errors) ? errors : [];
        const message = reasons[0]?.reason ?? `Linode API error (${response.status})`;
        throw new LinodeError(message, response.status, reasons);
    }

    return json as T;
}

/** Random, high-entropy, and guaranteed to satisfy Linode's strength rules. */
export function generateRootPassword(): string {
    return randomBytes(24).toString("base64url") + "aA1!";
}

export class LinodeClient {
    private token: string;

    constructor(token: string) {
        this.token = token;
    }

    /** Throws LinodeError (401/403) if the token is invalid or lacks Linodes access. */
    async verify(): Promise<void> {
        await request("GET", "/linode/instances?page_size=25", this.token);
    }

    async createInstance(input: CreateInstanceInput): Promise<LinodeInstance> {
        const raw = await request<RawInstance>("POST", "/linode/instances", this.token, {
            region: input.region,
            type: input.type,
            image: input.image,
            label: input.label,
            root_pass: input.rootPassword,
            authorized_keys: input.authorizedKeys,
            booted: true,
            tags: input.tags ?? [],
        });
        return toInstance(raw);
    }

    async getInstance(id: number): Promise<LinodeInstance> {
        return toInstance(await request<RawInstance>("GET", `/linode/instances/${id}`, this.token));
    }

    /** Finds an instance by its exact label, or null. Used to resume a provision safely. */
    async findByLabel(label: string): Promise<LinodeInstance | null> {
        const res = await request<{ data: RawInstance[] }>(
            "GET",
            "/linode/instances?page_size=25",
            this.token,
            undefined,
            { "X-Filter": JSON.stringify({ label }) },
        );
        return res.data.length > 0 ? toInstance(res.data[0]) : null;
    }

    async deleteInstance(id: number): Promise<void> {
        await request("DELETE", `/linode/instances/${id}`, this.token);
    }

    // ---- Billing (token needs the "Account" scope) ----

    async getAccount(): Promise<LinodeAccount> {
        const raw = await request<{
            balance?: number | string;
            balance_uninvoiced?: number | string;
            billing_source?: string;
        }>("GET", "/account", this.token);

        return {
            balance: Number(raw.balance ?? 0),
            balanceUninvoiced: Number(raw.balance_uninvoiced ?? 0),
            billingSource: String(raw.billing_source ?? ""),
        };
    }

    /** The 25 newest invoices, newest first. */
    async listInvoices(): Promise<LinodeInvoice[]> {
        const res = await request<{ data: RawInvoice[] }>(
            "GET",
            "/account/invoices?page_size=25",
            this.token,
            undefined,
            { "X-Filter": JSON.stringify({ "+order_by": "date", "+order": "desc" }) },
        );

        return (res.data ?? []).map((i) => ({
            id: Number(i.id),
            date: String(i.date ?? ""),
            label: String(i.label ?? ""),
            total: Number(i.total ?? 0),
        }));
    }

    async listPaymentMethods(): Promise<LinodePaymentMethod[]> {
        const res = await request<{ data: RawPaymentMethod[] }>(
            "GET",
            "/account/payment-methods?page_size=25",
            this.token,
        );

        return (res.data ?? []).map((m) => ({
            id: Number(m.id),
            type: String(m.type ?? ""),
            isDefault: Boolean(m.is_default),
            cardType: String(m.data?.card_type ?? ""),
            lastFour: String(m.data?.last_four ?? ""),
        }));
    }

    /**
     * Charges a saved payment method. `cvv` is required by Linode for credit
     * cards only. This is NEVER retried: if the request times out the outcome is
     * unknown, and a second attempt could charge twice. The CVV is used for this
     * one request and is not kept anywhere.
     */
    async makePayment(amountUsd: number, paymentMethodId: number, cvv?: string): Promise<LinodePayment> {
        const body: Record<string, unknown> = {
            usd: amountUsd.toFixed(2),
            payment_method_id: paymentMethodId,
        };
        if (cvv) body.cvv = cvv;

        const raw = await request<{ id: number; date?: string; usd?: number | string }>(
            "POST",
            "/account/payments",
            this.token,
            body,
        );

        return {
            id: Number(raw.id),
            date: String(raw.date ?? ""),
            usd: Number(raw.usd ?? amountUsd),
        };
    }

    // ---- Public catalog (no token needed) ----

    static async regions(): Promise<LinodeRegion[]> {
        const res = await request<{
            data: { id: string; label: string; country: string; status: string; capabilities: string[] }[];
        }>("GET", "/regions?page_size=500", null);

        return res.data
            .filter((r) => r.status === "ok" && r.capabilities.includes("Linodes"))
            .map((r) => ({ id: r.id, label: r.label, country: r.country }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    static async plans(region?: string): Promise<LinodePlan[]> {
        const res = await request<{
            data: {
                id: string;
                label: string;
                class: string;
                memory: number;
                vcpus: number;
                disk: number;
                price: { hourly: number | null; monthly: number | null };
                region_prices?: { id: string; hourly: number; monthly: number }[];
            }[];
        }>("GET", "/linode/types?page_size=500", null);

        const allowed = new Set(["nanode", "standard", "dedicated"]);
        const plans: LinodePlan[] = [];

        for (const t of res.data) {
            if (!allowed.has(t.class)) continue;

            const regional = region ? t.region_prices?.find((p) => p.id === region) : undefined;
            const monthly = regional?.monthly ?? t.price.monthly;
            const hourly = regional?.hourly ?? t.price.hourly;

            // No usable price for this region means the plan isn't offered there.
            if (monthly == null || hourly == null) continue;

            plans.push({
                id: t.id,
                label: t.label,
                class: t.class,
                memory_mb: t.memory,
                vcpus: t.vcpus,
                disk_gb: Math.round(t.disk / 1024),
                monthly,
                hourly,
            });
        }

        return plans.sort((a, b) => a.monthly - b.monthly);
    }

    static async images(): Promise<LinodeImage[]> {
        const res = await request<{
            data: { id: string; is_public?: boolean; deprecated?: boolean }[];
        }>("GET", "/images?page_size=500", null);

        const available = new Set(
            res.data.filter((i) => i.is_public && !i.deprecated).map((i) => i.id),
        );

        return Object.keys(SUPPORTED_IMAGES)
            .filter((id) => available.has(id))
            .map((id) => ({ id, label: SUPPORTED_IMAGES[id] }));
    }
}