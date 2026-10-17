/**
 * Spaceship (https://docs.spaceship.dev/)
 *
 *   - Credentials: { api_key, api_secret } as JSON, sent as X-API-Key / X-API-Secret
 *     to https://spaceship.dev/api/v1.
 *   - Domain id = the domain name.
 *   - DNS records have NO id and are typed by field (address / cname / exchange / value /
 *     nameserver). The id handed out is the record's own JSON, packed with encodeRef.
 *     Update = save the new record, then delete the old one (never a window with neither).
 *   - Locked = the domain's eppStatuses contain a *TransferProhibited status.
 *   - No billing API.
 *
 * VERIFY BEFORE USE: the DELETE body (an array of record objects), the `force` flag on
 * PUT, and the nameservers / autorenew / transfer-lock paths are from memory.
 */

import {
    type DnsRecord,
    type DnsRecordInput,
    type DomainSummary,
    type RegistrarAdapter,
    REGISTRAR_FEATURES,
} from "../RegistrarAdapter.js";
import { decodeRef, encodeRef, http, parseCreds, RegistrarError, type Json } from "./http.js";

const BASE = "https://spaceship.dev/api/v1";

export class SpaceshipAdapter implements RegistrarAdapter {
    kind = "spaceship" as const;
    features = REGISTRAR_FEATURES.spaceship;
    private key: string;
    private secret: string;

    constructor(secret: string) {
        const c = parseCreds(secret, ["api_key", "api_secret"], "Spaceship");
        this.key = c.api_key;
        this.secret = c.api_secret;
    }

    private async call(method: string, path: string, body?: unknown): Promise<Json> {
        const { status, data } = await http(BASE + path, {
            method,
            headers: {
                "X-API-Key": this.key,
                "X-API-Secret": this.secret,
                Accept: "application/json",
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (status < 400) return data;

        const message = String(data?.detail || data?.message || data?.title || `Spaceship API error (${status})`);
        throw new RegistrarError(message, status, String(data?.code ?? ""));
    }

    async verify() {
        await this.call("GET", "/domains?take=1&skip=0");
    }

    isAuthError(e: unknown) {
        return e instanceof RegistrarError && e.isAuth;
    }
    isTransient(e: unknown) {
        return e instanceof RegistrarError && e.isTransient;
    }
    describeError(e: unknown) {
        return e instanceof RegistrarError ? `Spaceship: ${e.message}` : null;
    }

    private async pages(path: string): Promise<Json[]> {
        const out: Json[] = [];
        const sep = path.includes("?") ? "&" : "?";

        for (let skip = 0; ; skip += 100) {
            const data = await this.call("GET", `${path}${sep}take=100&skip=${skip}`);
            const items = (data.items ?? []) as Json[];
            out.push(...items);
            if (items.length < 100 || out.length >= Number(data.total ?? 0)) break;
        }
        return out;
    }

    async domains(): Promise<DomainSummary[]> {
        const rows = await this.pages("/domains");
        return rows
            .map((d) => ({
                id: String(d.name),
                name: String(d.name),
                status: String(d.lifecycleStatus ?? "").toLowerCase(),
                expires: String(d.expirationDate ?? "").slice(0, 10),
                autoRenew: typeof d.autoRenew === "boolean" ? d.autoRenew : null,
                locked: Array.isArray(d.eppStatuses) ? d.eppStatuses.some((s: unknown) => /transferProhibited/i.test(String(s))) : null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    private toRecord(r: Json): DnsRecord {
        const value = r.address ?? r.cname ?? r.exchange ?? r.value ?? r.nameserver ?? r.aliasName ?? "";
        const type = String(r.type).toUpperCase();
        return {
            id: encodeRef([JSON.stringify(r)]),
            type,
            name: String(r.name ?? "@"),
            value: String(value),
            ttl: Number(r.ttl ?? 3600),
            priority: type === "MX" && r.preference !== undefined ? Number(r.preference) : null,
        };
    }

    private item(input: DnsRecordInput): Json {
        const base = { type: input.type, name: input.name, ttl: input.ttl };
        switch (input.type) {
            case "A":
            case "AAAA":
                return { ...base, address: input.value };
            case "CNAME":
                return { ...base, cname: input.value };
            case "MX":
                return { ...base, exchange: input.value, preference: input.priority ?? 10 };
            case "TXT":
                return { ...base, value: input.value };
            case "NS":
                return { ...base, nameserver: input.value };
            default:
                throw new RegistrarError(`Spaceship records of type ${input.type} aren't supported here.`, 422);
        }
    }

    async records(domain: string) {
        const rows = await this.pages(`/dns/records/${encodeURIComponent(domain)}`);
        return rows.map((r) => this.toRecord(r));
    }

    async addRecord(domain: string, input: DnsRecordInput) {
        const item = this.item(input);
        await this.call("PUT", `/dns/records/${encodeURIComponent(domain)}`, { force: false, items: [item] });
        return this.toRecord(item);
    }

    async updateRecord(domain: string, id: string, input: DnsRecordInput) {
        const old = JSON.parse(decodeRef(id, 1)[0]);
        const created = await this.addRecord(domain, input);
        if (created.id !== id) await this.call("DELETE", `/dns/records/${encodeURIComponent(domain)}`, [old]);
        return created;
    }

    async removeRecord(domain: string, id: string) {
        const old = JSON.parse(decodeRef(id, 1)[0]);
        try {
            await this.call("DELETE", `/dns/records/${encodeURIComponent(domain)}`, [old]);
        } catch (error) {
            if (error instanceof RegistrarError && error.status === 404) return;
            throw error;
        }
    }

    async nameservers(domain: string) {
        const d = await this.call("GET", `/domains/${encodeURIComponent(domain)}`);
        return ((d.nameservers?.hosts ?? []) as string[]).map(String);
    }

    async setNameservers(domain: string, servers: string[]) {
        await this.call("PUT", `/domains/${encodeURIComponent(domain)}/nameservers`, { provider: "custom", hosts: servers });
    }

    async setAutoRenew(domain: string, on: boolean) {
        await this.call("PUT", `/domains/${encodeURIComponent(domain)}/autorenew`, { isEnabled: on });
    }

    async setLock(domain: string, on: boolean) {
        await this.call("PUT", `/domains/${encodeURIComponent(domain)}/transfer/lock`, { isLocked: on });
    }
}