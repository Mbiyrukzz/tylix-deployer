/**
 * Minimal Contabo API client for the deployer (https://api.contabo.com/v1).
 *
 *   - Credentials are four values from the Customer Control Panel, stored as JSON in
 *     providers.credentials: client_id, client_secret, api_user, api_password.
 *     We exchange them for a short-lived OAuth2 token (password grant) and cache it.
 *   - Every API call needs a fresh x-request-id UUID.
 *   - Machines are referenced by numeric instanceId (kept as a string).
 *   - The deploy key is stored as an "ssh" secret and attached by secretId at create time.
 *   - Idempotent retry: displayName starts with "tylix-provision-<id>-". The ssh secret is
 *     named tylix-provision-<id> and reused.
 *   - Contabo has no product list endpoint, so the plans are a curated table below.
 *   - DELETE IS NOT IMMEDIATE: Contabo instances are monthly contracts. "remove" schedules
 *     the cancellation, and the machine keeps running (and billing) until the period ends.
 */

import { randomUUID } from "node:crypto";

const API = "https://api.contabo.com/v1";
const AUTH_URL = "https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token";
const TIMEOUT_MS = 20_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/**
 * VERIFY BEFORE USE: product ids, specs and the region ids below are from memory.
 * Check them against Contabo's API docs / order page. A wrong id here creates a
 * machine of a different size than the one the user picked.
 * [productId, label, vcpus, memory_mb, disk_gb]
 */
const PRODUCTS: [string, string, number, number, number][] = [
    ["V91", "Cloud VPS 10", 4, 8192, 75],
    ["V92", "Cloud VPS 20", 6, 12288, 100],
    ["V93", "Cloud VPS 30", 8, 24576, 200],
    ["V94", "Cloud VPS 40", 12, 49152, 250],
    ["V95", "Cloud VPS 50", 16, 65536, 300],
    ["V96", "Cloud VPS 60", 18, 98304, 350],
];

const REGIONS: [string, string, string][] = [
    ["EU", "Germany (Nuremberg)", "DE"],
    ["UK", "United Kingdom (Portsmouth)", "GB"],
    ["US-central", "US Central (St. Louis)", "US"],
    ["US-east", "US East (New York)", "US"],
    ["US-west", "US West (Seattle)", "US"],
    ["SIN", "Singapore", "SG"],
    ["AUS", "Australia (Sydney)", "AU"],
    ["JPN", "Japan (Tokyo)", "JP"],
    ["IND", "India (Mumbai)", "IN"],
];

export interface ContaboCredentials {
    clientId: string;
    clientSecret: string;
    apiUser: string;
    apiPassword: string;
}
export interface ContaboRegion { id: string; label: string; country: string }
export interface ContaboPlan {
    id: string; label: string; class: string; memory_mb: number; vcpus: number;
    disk_gb: number; monthly: number; hourly: number; currency: "EUR";
}
export interface ContaboImage { id: string; label: string }

export interface ContaboInstance {
    id: string;
    /** provisioning, installing, running, stopped, error, ... */
    status: string;
    ip: string;
    /** Set once a cancellation is scheduled. */
    cancelDate: string;
}

export interface CreateContaboInput {
    provisionId: number;
    region: string;
    productId: string;
    imageId: string;
    name: string;
    publicKey: string;
}

export class ContaboError extends Error {
    status: number;
    code: string;

    constructor(message: string, status: number, code = "") {
        super(message);
        this.name = "ContaboError";
        this.status = status;
        this.code = code;
    }

    get isAuth(): boolean {
        return this.status === 401 || this.status === 403;
    }

    get isTransient(): boolean {
        return this.status === 0 || this.status === 429 || this.status >= 500;
    }
}

export function parseContaboCredentials(secret: string): ContaboCredentials {
    let d: Record<string, unknown> | null = null;
    try {
        d = JSON.parse(secret);
    } catch {
        /* handled below */
    }

    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const creds = {
        clientId: s(d?.client_id),
        clientSecret: s(d?.client_secret),
        apiUser: s(d?.api_user),
        apiPassword: s(d?.api_password),
    };

    if (!creds.clientId || !creds.clientSecret || !creds.apiUser || !creds.apiPassword) {
        throw new Error("The stored Contabo credentials are incomplete.");
    }
    return creds;
}

function toInstance(raw: Json): ContaboInstance {
    return {
        id: String(raw.instanceId),
        status: String(raw.status ?? ""),
        ip: String(raw?.ipConfig?.v4?.ip ?? ""),
        cancelDate: String(raw.cancelDate ?? ""),
    };
}

export class ContaboClient {
    private creds: ContaboCredentials;
    private token = "";
    private tokenExpires = 0;

    constructor(creds: ContaboCredentials) {
        this.creds = creds;
    }

    private async fetchJson(url: string, init: RequestInit): Promise<{ res: Response; data: Json }> {
        let res: Response;
        try {
            res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch {
            throw new ContaboError("Could not reach Contabo.", 0);
        }

        const text = await res.text();
        let data: Json = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            /* non-JSON body */
        }
        return { res, data };
    }

    private async getToken(): Promise<string> {
        if (this.token && Date.now() < this.tokenExpires - 15_000) return this.token;

        const { res, data } = await this.fetchJson(AUTH_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: this.creds.clientId,
                client_secret: this.creds.clientSecret,
                username: this.creds.apiUser,
                password: this.creds.apiPassword,
                grant_type: "password",
            }).toString(),
        });

        if (!res.ok || !data.access_token) {
            // Wrong client id/secret or user/password all come back as 400/401.
            const bad = res.status === 400 || res.status === 401 || res.status === 403;
            throw new ContaboError(
                bad ? "Contabo rejected the client ID, client secret, API user or API password." : `Contabo auth error (${res.status})`,
                bad ? 401 : res.status,
                String(data.error ?? ""),
            );
        }

        this.token = String(data.access_token);
        this.tokenExpires = Date.now() + Number(data.expires_in ?? 300) * 1000;
        return this.token;
    }

    private async request<T = Json>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
        const token = await this.getToken();

        const { res, data } = await this.fetchJson(API + path, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                "x-request-id": randomUUID(),
                Accept: "application/json",
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (res.status === 401 && !retried) {
            this.token = "";
            return this.request(method, path, body, true);
        }

        if (!res.ok) {
            throw new ContaboError(
                String(data?.message || `Contabo API error (${res.status})`),
                res.status,
                String(data?.error ?? ""),
            );
        }
        return data as T;
    }

    /** Read-only: gets a token and lists one instance. */
    async verify(): Promise<void> {
        await this.request("GET", "/compute/instances?page=1&size=1");
    }

    // ---- Catalog ----

    regions(): ContaboRegion[] {
        return REGIONS.map(([id, label, country]) => ({ id, label, country }));
    }

    plans(_region?: string): ContaboPlan[] {
        return PRODUCTS.map(([id, label, vcpus, memory_mb, disk_gb]) => ({
            id, label, class: "general", memory_mb, vcpus, disk_gb,
            monthly: 0, // prices are not looked up
            hourly: 0,
            currency: "EUR" as const,
        }));
    }

    async images(): Promise<ContaboImage[]> {
        const res = await this.request("GET", "/compute/images?standardImage=true&size=100");
        const rows: Json[] = res?.data ?? [];

        return rows
            .filter((i) => /ubuntu/i.test(String(i.name)) && String(i.osType ?? "Linux") === "Linux")
            .map((i) => ({ id: String(i.imageId), label: String(i.name) }))
            .sort((a, b) => b.label.localeCompare(a.label)); // newest Ubuntu first
    }

    // ---- Machines ----

    /** The deploy key as a Contabo "ssh" secret. Reused when a retry already created it. */
    private async ensureSshSecret(provisionId: number, publicKey: string): Promise<number> {
        const name = `tylix-provision-${provisionId}`;

        const found = await this.request("GET", `/secrets?name=${encodeURIComponent(name)}&type=ssh`);
        const existing = ((found?.data ?? []) as Json[]).find((s) => s.name === name);
        if (existing) return Number(existing.secretId);

        const created = await this.request("POST", "/secrets", { name, value: publicKey.trim(), type: "ssh" });
        const id = Number(created?.data?.[0]?.secretId);
        if (!id) throw new ContaboError("Contabo accepted the key but returned no secret id.", 502, "NoSecret");
        return id;
    }

    async createInstance(input: CreateContaboInput): Promise<ContaboInstance> {
        const secretId = await this.ensureSshSecret(input.provisionId, input.publicKey);

        const res = await this.request("POST", "/compute/instances", {
            imageId: input.imageId,
            productId: input.productId,
            region: input.region,
            sshKeys: [secretId],
            defaultUser: "root",
            displayName: `tylix-provision-${input.provisionId}-${input.name}`.slice(0, 250),
            period: 1,
        });

        const raw = res?.data?.[0];
        if (!raw?.instanceId) throw new ContaboError("Contabo accepted the request but returned no instance.", 502, "NoInstance");
        return toInstance(raw);
    }

    async getInstance(id: string): Promise<ContaboInstance> {
        const res = await this.request("GET", `/compute/instances/${encodeURIComponent(id)}`);
        const raw = res?.data?.[0];
        if (!raw) throw new ContaboError("Instance not found.", 404, "NotFound");
        return toInstance(raw);
    }

    /** Our own machine, found by displayName prefix (never by plain name). Cancelled ones don't count. */
    async findByProvision(provisionId: number): Promise<ContaboInstance | null> {
        const prefix = `tylix-provision-${provisionId}-`;
        const res = await this.request("GET", `/compute/instances?displayName=${encodeURIComponent(prefix)}&size=100`);

        const raw = ((res?.data ?? []) as Json[]).find(
            (i) => String(i.displayName ?? "").startsWith(prefix) && !i.cancelDate,
        );
        return raw ? toInstance(raw) : null;
    }

    /** Schedules the cancellation (end of the billing period). Already cancelled or gone counts as success. */
    async cancelInstance(id: string): Promise<void> {
        try {
            const current = await this.getInstance(id);
            if (current.cancelDate) return;

            await this.request("POST", `/compute/instances/${encodeURIComponent(id)}/cancel`, {});
        } catch (error) {
            if (error instanceof ContaboError && error.status === 404) return;
            throw error;
        }
    }
}