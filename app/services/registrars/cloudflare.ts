/**
 * Cloudflare (https://developers.cloudflare.com/api/)
 *
 *   - Credentials: a single API token (Bearer) in registrars.api_token.
 *     Needed permissions: Zone:Read, DNS:Edit, Email Routing Rules:Edit
 *     (only for the forwarding feature) and Billing:Read (only for billing).
 *   - Domain id = the ZONE id (not the name), so every call after the list is by zone.
 *   - Cloudflare Registrar has no public API for listing expiry, renewing or
 *     transferring, so this adapter manages zones: DNS, nameservers (read-only),
 *     email forwarding and billing history. `expires` is always "".
 *   - TTL 1 means "automatic".
 *
 * VERIFY BEFORE USE: the Email Routing paths, the rule id field and the billing
 * history path/fields are from memory.
 */

import {
    type BillingSummary,
    type DnsRecord,
    type DnsRecordInput,
    type DomainSummary,
    type Forwarder,
    type RegistrarAdapter,
    REGISTRAR_FEATURES,
} from "../RegistrarAdapter.js";
import { http, relName, RegistrarError, type Json } from "./http.js";

const BASE = "https://api.cloudflare.com/client/v4";

export class CloudflareAdapter implements RegistrarAdapter {
    kind = "cloudflare" as const;
    features = REGISTRAR_FEATURES.cloudflare;
    private token: string;
    private zoneNames = new Map<string, string>();

    constructor(secret: string) {
        if (!secret.trim()) throw new Error("The stored Cloudflare token is empty.");
        this.token = secret.trim();
    }

    private async call(method: string, path: string, body?: unknown): Promise<Json> {
        const { status, data } = await http(BASE + path, {
            method,
            headers: {
                Authorization: `Bearer ${this.token}`,
                Accept: "application/json",
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (status < 400 && data.success !== false) return data;

        const first = (data.errors ?? [])[0] ?? {};
        const message = String(first.message || `Cloudflare API error (${status})`);
        // 10000 = authentication error; 9109 = valid token but not allowed to this resource.
        const auth = status === 401 || status === 403 || first.code === 10000 || first.code === 9109;
        throw new RegistrarError(message, auth ? 403 : status, String(first.code ?? ""));
    }

    /** Pages through a list endpoint. */
    private async all(path: string): Promise<Json[]> {
        const out: Json[] = [];
        const sep = path.includes("?") ? "&" : "?";

        for (let page = 1; ; page++) {
            const data = await this.call("GET", `${path}${sep}per_page=100&page=${page}`);
            out.push(...((data.result ?? []) as Json[]));
            if (page >= Number(data.result_info?.total_pages ?? 1)) break;
        }
        return out;
    }

    async verify() {
        await this.call("GET", "/user/tokens/verify");
    }

    isAuthError(e: unknown) {
        return e instanceof RegistrarError && e.isAuth;
    }
    isTransient(e: unknown) {
        return e instanceof RegistrarError && e.isTransient;
    }
    describeError(e: unknown) {
        return e instanceof RegistrarError ? `Cloudflare: ${e.message}` : null;
    }

    async domains(): Promise<DomainSummary[]> {
        const zones = await this.all("/zones");

        for (const z of zones) this.zoneNames.set(String(z.id), String(z.name));

        return zones
            .map((z) => ({
                id: String(z.id),
                name: String(z.name),
                status: String(z.status ?? ""),
                expires: "",
                autoRenew: null,
                locked: null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    private async zoneName(zoneId: string): Promise<string> {
        const known = this.zoneNames.get(zoneId);
        if (known) return known;

        const data = await this.call("GET", `/zones/${encodeURIComponent(zoneId)}`);
        const name = String(data.result?.name ?? "");
        this.zoneNames.set(zoneId, name);
        return name;
    }

    private toRecord(zone: string, r: Json): DnsRecord {
        return {
            id: String(r.id),
            type: String(r.type),
            name: relName(String(r.name), zone),
            value: String(r.content ?? ""),
            ttl: Number(r.ttl ?? 1),
            priority: r.priority === undefined || r.priority === null ? null : Number(r.priority),
            proxied: Boolean(r.proxied),
        };
    }

    private body(zone: string, input: DnsRecordInput) {
        return {
            type: input.type,
            name: input.name === "@" ? zone : input.name,
            content: input.value,
            ttl: input.ttl || 1,
            ...(input.priority !== null ? { priority: input.priority } : {}),
            ...(input.proxied !== undefined ? { proxied: input.proxied } : {}),
        };
    }

    async records(zoneId: string) {
        const zone = await this.zoneName(zoneId);
        const rows = await this.all(`/zones/${encodeURIComponent(zoneId)}/dns_records`);
        return rows.map((r) => this.toRecord(zone, r));
    }

    async addRecord(zoneId: string, input: DnsRecordInput) {
        const zone = await this.zoneName(zoneId);
        const data = await this.call("POST", `/zones/${encodeURIComponent(zoneId)}/dns_records`, this.body(zone, input));
        return this.toRecord(zone, data.result);
    }

    async updateRecord(zoneId: string, id: string, input: DnsRecordInput) {
        const zone = await this.zoneName(zoneId);
        const data = await this.call(
            "PUT",
            `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`,
            this.body(zone, input),
        );
        return this.toRecord(zone, data.result);
    }

    async removeRecord(zoneId: string, id: string) {
        try {
            await this.call("DELETE", `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(id)}`);
        } catch (error) {
            if (error instanceof RegistrarError && error.status === 404) return;
            throw error;
        }
    }

    // Read-only: a zone's nameservers are assigned by Cloudflare. Changing them
    // happens at the registrar the domain is registered with.
    async nameservers(zoneId: string) {
        const data = await this.call("GET", `/zones/${encodeURIComponent(zoneId)}`);
        return ((data.result?.name_servers ?? []) as string[]).map(String);
    }

    // ---- Email Routing: forwarding only (no mailboxes) ----

    private toForwarder(r: Json): Forwarder {
        return {
            id: String(r.id ?? r.tag),
            from: String(r.matchers?.[0]?.value ?? ""),
            to: String(r.actions?.[0]?.value?.[0] ?? ""),
            enabled: Boolean(r.enabled),
        };
    }

    async forwarders(zoneId: string) {
        const rows = await this.all(`/zones/${encodeURIComponent(zoneId)}/email/routing/rules`);
        return rows
            .filter((r) => r.matchers?.[0]?.type === "literal" && r.actions?.[0]?.type === "forward")
            .map((r) => this.toForwarder(r));
    }

    // The destination address must be verified in Cloudflare first (it emails a link).
    async addForwarder(zoneId: string, from: string, to: string) {
        const data = await this.call("POST", `/zones/${encodeURIComponent(zoneId)}/email/routing/rules`, {
            name: `forward ${from}`,
            enabled: true,
            matchers: [{ type: "literal", field: "to", value: from }],
            actions: [{ type: "forward", value: [to] }],
        });
        return this.toForwarder(data.result);
    }

    async removeForwarder(zoneId: string, id: string) {
        try {
            await this.call("DELETE", `/zones/${encodeURIComponent(zoneId)}/email/routing/rules/${encodeURIComponent(id)}`);
        } catch (error) {
            if (error instanceof RegistrarError && error.status === 404) return;
            throw error;
        }
    }

    // ---- Billing: history of the user the token belongs to ----

    // Needs the token permission "Billing: Read". There is no balance in this API,
    // so `balance` stays null. Only the latest 50 entries are read.
    async billing(): Promise<BillingSummary> {
        const data = await this.call("GET", "/user/billing/history?per_page=50&page=1");

        const lines = ((data.result ?? []) as Json[])
            .map((r) => ({
                id: String(r.id),
                date: String(r.occurred_at ?? "").slice(0, 10),
                description: String(r.description || r.type || ""),
                amount: Number(r.amount ?? 0),
                currency: String(r.currency || "USD").toUpperCase(),
            }))
            .sort((a, b) => b.date.localeCompare(a.date));

        return { balance: null, lines };
    }
}