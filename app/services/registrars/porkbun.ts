/**
 * Porkbun (https://porkbun.com/api/json/v3/documentation)
 *
 *   - Credentials: { api_key, secret_key } stored as JSON. Every call is a POST
 *     with both keys in the body. API access must be switched on per domain in
 *     the Porkbun dashboard, or that domain won't show up in the list.
 *   - Domain id = the domain name.
 *   - Errors come back as { status: "ERROR", message } (sometimes with HTTP 200).
 *
 * VERIFY BEFORE USE: endpoint names and field names below are from memory of the
 * v3 docs. Run verify() and one list call against a throwaway domain first.
 */

import {
    type DnsRecord,
    type DnsRecordInput,
    type DomainSummary,
    type RegistrarAdapter,
    REGISTRAR_FEATURES,
} from "../RegistrarAdapter.js";
import { http, parseCreds, relName, RegistrarError, type Json } from "./http.js";

const BASE = "https://api.porkbun.com/api/json/v3";

export class PorkbunAdapter implements RegistrarAdapter {
    kind = "porkbun" as const;
    features = REGISTRAR_FEATURES.porkbun;
    private auth: { apikey: string; secretapikey: string };

    constructor(secret: string) {
        const c = parseCreds(secret, ["api_key", "secret_key"], "Porkbun");
        this.auth = { apikey: c.api_key, secretapikey: c.secret_key };
    }

    private async call(path: string, body: Record<string, unknown> = {}): Promise<Json> {
        const { status, data } = await http(BASE + path, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ ...this.auth, ...body }),
        });

        if (status < 400 && data.status === "SUCCESS") return data;

        const message = String(data.message || `Porkbun API error (${status})`);
        // Bad keys can arrive as HTTP 200/400 with an ERROR body, so look at the text too.
        const auth = status === 401 || status === 403 || /api key|apikey|not authorized|api access/i.test(message);
        throw new RegistrarError(message, auth ? 401 : status >= 400 ? status : 400);
    }

    verify() {
        return this.call("/ping").then(() => undefined);
    }

    isAuthError(e: unknown) {
        return e instanceof RegistrarError && e.isAuth;
    }
    isTransient(e: unknown) {
        return e instanceof RegistrarError && e.isTransient;
    }
    describeError(e: unknown) {
        return e instanceof RegistrarError ? `Porkbun: ${e.message}` : null;
    }

    async domains(): Promise<DomainSummary[]> {
        const out: DomainSummary[] = [];

        for (let start = 0; ; start += 1000) {
            const data = await this.call("/domain/listAll", { start, includeLabels: "no" });
            const rows: Json[] = data.domains ?? [];

            for (const d of rows) {
                out.push({
                    id: String(d.domain),
                    name: String(d.domain),
                    status: String(d.status ?? "ACTIVE").toLowerCase(),
                    expires: String(d.expireDate ?? "").slice(0, 10),
                    autoRenew: d.autoRenew === undefined ? null : Boolean(Number(d.autoRenew)),
                    locked: d.securityLock === undefined ? null : Boolean(Number(d.securityLock)),
                });
            }
            if (rows.length < 1000) break;
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    private toRecord(domain: string, r: Json): DnsRecord {
        return {
            id: String(r.id),
            type: String(r.type),
            name: relName(String(r.name), domain),
            value: String(r.content ?? ""),
            ttl: Number(r.ttl ?? 600),
            priority: r.prio === null || r.prio === undefined || r.prio === "" ? null : Number(r.prio),
        };
    }

    private body(input: DnsRecordInput) {
        return {
            name: input.name === "@" ? "" : input.name,
            type: input.type,
            content: input.value,
            ttl: String(input.ttl),
            ...(input.priority !== null ? { prio: String(input.priority) } : {}),
        };
    }

    async records(domain: string) {
        const data = await this.call(`/dns/retrieve/${encodeURIComponent(domain)}`);
        return ((data.records ?? []) as Json[]).map((r) => this.toRecord(domain, r));
    }

    async addRecord(domain: string, input: DnsRecordInput) {
        const data = await this.call(`/dns/create/${encodeURIComponent(domain)}`, this.body(input));
        return { id: String(data.id), ...input };
    }

    async updateRecord(domain: string, id: string, input: DnsRecordInput) {
        await this.call(`/dns/edit/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`, this.body(input));
        return { id, ...input };
    }

    async removeRecord(domain: string, id: string) {
        try {
            await this.call(`/dns/delete/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`);
        } catch (error) {
            if (error instanceof RegistrarError && /not found|invalid record/i.test(error.message)) return;
            throw error;
        }
    }

    async nameservers(domain: string) {
        const data = await this.call(`/domain/getNs/${encodeURIComponent(domain)}`);
        return ((data.ns ?? []) as string[]).map(String);
    }

    async setNameservers(domain: string, servers: string[]) {
        await this.call(`/domain/updateNs/${encodeURIComponent(domain)}`, { ns: servers });
    }
}
