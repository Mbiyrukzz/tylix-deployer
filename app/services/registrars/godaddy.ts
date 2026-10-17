/**
 * GoDaddy (https://developer.godaddy.com/doc/endpoint/domains)
 *
 *   - Credentials: { api_key, api_secret } as JSON. Header: "sso-key KEY:SECRET".
 *     Production keys only. GoDaddy has limited Domains API access to accounts
 *     with a minimum number of domains, so verify() can fail with 403 on a small
 *     account even when the keys are right. The error text says so.
 *   - Domain id = the domain name.
 *   - GoDaddy DNS records have NO id. A record is addressed by (type, name) and
 *     PUT replaces EVERY record with that type+name. So the id we hand out is
 *     base64url([type, name, value]); update/remove read the current set for
 *     that type+name, change just the one item, and PUT the rest back.
 *   - Settings: auto-renew and transfer lock via PATCH /v1/domains/{domain}.
 *
 * VERIFY BEFORE USE: field names are from memory of the v1 API; try a throwaway domain.
 */

import {
    type DnsRecord,
    type DnsRecordInput,
    type DomainSummary,
    type RegistrarAdapter,
    REGISTRAR_FEATURES,
} from "../RegistrarAdapter.js";
import { http, parseCreds, RegistrarError, type Json } from "./http.js";

const BASE = "https://api.godaddy.com/v1";

const encodeId = (type: string, name: string, value: string) =>
    Buffer.from(JSON.stringify([type, name, value]), "utf8").toString("base64url");

function decodeId(id: string): [string, string, string] {
    try {
        const parts = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
        if (Array.isArray(parts) && parts.length === 3) return parts.map(String) as [string, string, string];
    } catch {
        /* falls through */
    }
    throw new RegistrarError("That isn't a valid record reference.", 400, "BadReference");
}

export class GoDaddyAdapter implements RegistrarAdapter {
    kind = "godaddy" as const;
    features = REGISTRAR_FEATURES.godaddy;
    private authHeader: string;

    constructor(secret: string) {
        const c = parseCreds(secret, ["api_key", "api_secret"], "GoDaddy");
        this.authHeader = `sso-key ${c.api_key}:${c.api_secret}`;
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

        let message = String(data?.message || `GoDaddy API error (${status})`);
        if (status === 403) {
            message += " Use production API keys, and note GoDaddy limits Domains API access to accounts with enough domains.";
        }
        throw new RegistrarError(message, status, String(data?.code ?? ""));
    }

    async verify() {
        await this.call("GET", "/domains?limit=1");
    }

    isAuthError(e: unknown) {
        return e instanceof RegistrarError && e.isAuth;
    }
    isTransient(e: unknown) {
        return e instanceof RegistrarError && e.isTransient;
    }
    describeError(e: unknown) {
        return e instanceof RegistrarError ? `GoDaddy: ${e.message}` : null;
    }

    async domains(): Promise<DomainSummary[]> {
        const out: DomainSummary[] = [];
        let marker = "";

        for (;;) {
            const rows: Json[] = await this.call(
                "GET",
                `/domains?limit=1000${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`,
            );

            for (const d of rows) {
                out.push({
                    id: String(d.domain),
                    name: String(d.domain),
                    status: String(d.status ?? "").toLowerCase(),
                    expires: String(d.expires ?? "").slice(0, 10),
                    autoRenew: d.renewAuto === undefined ? null : Boolean(d.renewAuto),
                    locked: d.locked === undefined ? null : Boolean(d.locked),
                });
            }

            if (rows.length < 1000) break;
            marker = String(rows[rows.length - 1].domain);
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    private toRecord(r: Json): DnsRecord {
        const type = String(r.type);
        const name = String(r.name);
        const value = String(r.data ?? "");
        return {
            id: encodeId(type, name, value),
            type,
            name,
            value,
            ttl: Number(r.ttl ?? 600),
            priority: r.priority === undefined || r.priority === null ? null : Number(r.priority),
        };
    }

    private payload(input: DnsRecordInput) {
        return {
            data: input.value,
            ttl: input.ttl,
            ...(input.priority !== null ? { priority: input.priority } : {}),
        };
    }

    async records(domain: string) {
        const rows: Json[] = await this.call("GET", `/domains/${encodeURIComponent(domain)}/records`);
        return rows.map((r) => this.toRecord(r));
    }

    private async set(domain: string, type: string, name: string): Promise<Json[]> {
        return this.call("GET", `/domains/${encodeURIComponent(domain)}/records/${type}/${encodeURIComponent(name)}`);
    }

    async addRecord(domain: string, input: DnsRecordInput) {
        // PATCH appends, so existing records with the same type+name are untouched.
        await this.call("PATCH", `/domains/${encodeURIComponent(domain)}/records`, [
            { type: input.type, name: input.name, ...this.payload(input) },
        ]);
        return { id: encodeId(input.type, input.name, input.value), ...input };
    }

    async updateRecord(domain: string, id: string, input: DnsRecordInput) {
        const [type, name, value] = decodeId(id);
        const current = await this.set(domain, type, name);

        if (type !== input.type || name !== input.name) {
            // Moving to another type/name: remove the old one, add the new one.
            await this.removeRecord(domain, id);
            return this.addRecord(domain, input);
        }

        let replaced = false;
        const next = current.map((r) => {
            if (!replaced && String(r.data) === value) {
                replaced = true;
                return { ...r, ...this.payload(input) };
            }
            return r;
        });
        if (!replaced) throw new RegistrarError("GoDaddy couldn't find that record.", 404);

        await this.call("PUT", `/domains/${encodeURIComponent(domain)}/records/${type}/${encodeURIComponent(name)}`, next);
        return { id: encodeId(type, name, input.value), ...input };
    }

    async removeRecord(domain: string, id: string) {
        const [type, name, value] = decodeId(id);
        const current = await this.set(domain, type, name);
        const rest = current.filter((r) => String(r.data) !== value);

        if (rest.length === current.length) return; // already gone

        const path = `/domains/${encodeURIComponent(domain)}/records/${type}/${encodeURIComponent(name)}`;
        if (rest.length === 0) {
            await this.call("DELETE", path);
        } else {
            await this.call("PUT", path, rest);
        }
    }

    async nameservers(domain: string) {
        const d = await this.call("GET", `/domains/${encodeURIComponent(domain)}`);
        return ((d.nameServers ?? []) as string[]).map(String);
    }

    async setNameservers(domain: string, servers: string[]) {
        await this.call("PATCH", `/domains/${encodeURIComponent(domain)}`, { nameServers: servers });
    }

    async setAutoRenew(domain: string, on: boolean) {
        await this.call("PATCH", `/domains/${encodeURIComponent(domain)}`, { renewAuto: on });
    }

    async setLock(domain: string, on: boolean) {
        await this.call("PATCH", `/domains/${encodeURIComponent(domain)}`, { locked: on });
    }
}
