/**
 * Name.com (https://docs.name.com/)
 *
 *   - Credentials: { api_user, api_token } as JSON. HTTP Basic (username:token) against
 *     https://api.name.com/v4. Use the production token, not the test one.
 *   - Domain id = the domain name. Record id = Name.com's numeric record id.
 *   - Record host is relative; "" means the apex. Minimum TTL is 300.
 *   - Settings: auto-renew and transfer lock are `:enableAutorenew` / `:disableAutorenew`
 *     and `:lock` / `:unlock` actions on the domain.
 *   - No billing API and no email forwarding here (Name.com has one; not wired up).
 *
 * VERIFY BEFORE USE: action names (:enableAutorenew, :lock, :setNameservers) and the
 * pagination field (`nextPage`) are from memory of the v4 docs.
 */

import {
    type DnsRecord,
    type DnsRecordInput,
    type DomainSummary,
    type RegistrarAdapter,
    REGISTRAR_FEATURES,
} from "../RegistrarAdapter.js";
import { http, parseCreds, RegistrarError, type Json } from "./http.js";

const BASE = "https://api.name.com/v4";

export class NameComAdapter implements RegistrarAdapter {
    kind = "namecom" as const;
    features = REGISTRAR_FEATURES.namecom;
    private authHeader: string;

    constructor(secret: string) {
        const c = parseCreds(secret, ["api_user", "api_token"], "Name.com");
        this.authHeader = "Basic " + Buffer.from(`${c.api_user}:${c.api_token}`, "utf8").toString("base64");
    }

    private async call(method: string, path: string, body?: unknown): Promise<Json> {
        const { status, data } = await http(BASE + path, {
            method,
            headers: {
                Authorization: this.authHeader,
                Accept: "application/json",
                ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (status < 400) return data;

        const message = String(data?.message || data?.details || `Name.com API error (${status})`);
        throw new RegistrarError(message, status);
    }

    async verify() {
        await this.call("GET", "/domains?perPage=1&page=1");
    }

    isAuthError(e: unknown) {
        return e instanceof RegistrarError && e.isAuth;
    }
    isTransient(e: unknown) {
        return e instanceof RegistrarError && e.isTransient;
    }
    describeError(e: unknown) {
        return e instanceof RegistrarError ? `Name.com: ${e.message}` : null;
    }

    /** Follows `nextPage` until it runs out. `key` is the array field in each page. */
    private async pages(path: string, key: string): Promise<Json[]> {
        const out: Json[] = [];
        const sep = path.includes("?") ? "&" : "?";

        for (let page = 1, guard = 0; guard < 200; guard++) {
            const data = await this.call("GET", `${path}${sep}perPage=1000&page=${page}`);
            out.push(...((data[key] ?? []) as Json[]));
            if (!data.nextPage) break;
            page = Number(data.nextPage);
        }
        return out;
    }

    async domains(): Promise<DomainSummary[]> {
        const rows = await this.pages("/domains", "domains");
        return rows
            .map((d) => ({
                id: String(d.domainName),
                name: String(d.domainName),
                status: "active",
                expires: String(d.expireDate ?? "").slice(0, 10),
                autoRenew: typeof d.autorenewEnabled === "boolean" ? d.autorenewEnabled : null,
                locked: typeof d.locked === "boolean" ? d.locked : null,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    private toRecord(r: Json): DnsRecord {
        return {
            id: String(r.id),
            type: String(r.type),
            name: r.host ? String(r.host) : "@",
            value: String(r.answer ?? ""),
            ttl: Number(r.ttl ?? 300),
            priority: r.priority === undefined || r.priority === null ? null : Number(r.priority),
        };
    }

    private body(input: DnsRecordInput) {
        return {
            host: input.name === "@" ? "" : input.name,
            type: input.type,
            answer: input.value,
            ttl: Math.max(input.ttl, 300),
            ...(input.priority !== null ? { priority: input.priority } : {}),
        };
    }

    async records(domain: string) {
        const rows = await this.pages(`/domains/${encodeURIComponent(domain)}/records`, "records");
        return rows.map((r) => this.toRecord(r));
    }

    async addRecord(domain: string, input: DnsRecordInput) {
        const data = await this.call("POST", `/domains/${encodeURIComponent(domain)}/records`, this.body(input));
        return this.toRecord(data);
    }

    async updateRecord(domain: string, id: string, input: DnsRecordInput) {
        const data = await this.call(
            "PUT",
            `/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(id)}`,
            this.body(input),
        );
        return this.toRecord(data);
    }

    async removeRecord(domain: string, id: string) {
        try {
            await this.call("DELETE", `/domains/${encodeURIComponent(domain)}/records/${encodeURIComponent(id)}`);
        } catch (error) {
            if (error instanceof RegistrarError && error.status === 404) return;
            throw error;
        }
    }

    async nameservers(domain: string) {
        const d = await this.call("GET", `/domains/${encodeURIComponent(domain)}`);
        return ((d.nameservers ?? []) as string[]).map(String);
    }

    async setNameservers(domain: string, servers: string[]) {
        await this.call("POST", `/domains/${encodeURIComponent(domain)}:setNameservers`, { nameservers: servers });
    }

    async setAutoRenew(domain: string, on: boolean) {
        await this.call("POST", `/domains/${encodeURIComponent(domain)}:${on ? "enableAutorenew" : "disableAutorenew"}`, {});
    }

    async setLock(domain: string, on: boolean) {
        await this.call("POST", `/domains/${encodeURIComponent(domain)}:${on ? "lock" : "unlock"}`, {});
    }
}