/**
 * Namecheap (https://www.namecheap.com/support/api/methods/)
 *
 *   - Credentials: { api_user, api_key, client_ip } as JSON. XML over HTTPS (POST).
 *     UserName is sent as the API user (the usual case). client_ip is the public IP
 *     of THIS server: Namecheap only answers requests from whitelisted IPs, and the
 *     ClientIp parameter must match one of them.
 *   - Domain id = the domain name. SLD/TLD are split at the first dot
 *     (example.co.ke -> SLD example, TLD co.ke).
 *   - setHosts REPLACES every host record of the domain, and only works for domains
 *     using Namecheap's own DNS. Add/update/remove therefore read all hosts, change
 *     one and write them all back. Records have no stable id, so the id handed out
 *     is encodeRef([type, name, value]).
 *   - No API for auto-renew, so the "settings" feature is not offered.
 *   - Billing: getBalances only. No history API, so `lines` is always empty.
 *
 * VERIFY BEFORE USE: the error-message patterns used to tell auth errors apart,
 * and what setHosts does to EmailType when it is omitted. Try a throwaway domain
 * that has MX records before trusting add/update/remove on a live one.
 */

import {
    type BillingSummary,
    type DnsRecord,
    type DnsRecordInput,
    type DomainSummary,
    type RegistrarAdapter,
    REGISTRAR_FEATURES,
} from "../RegistrarAdapter.js";
import { decodeRef, encodeRef, http, parseCreds, RegistrarError } from "./http.js";
import { descendants, parseXml, textOf, valueOf, type XmlNode } from "./xml.js";

const BASE = "https://api.namecheap.com/xml.response";

interface Host {
    name: string;
    type: string;
    address: string;
    mxPref: string;
    ttl: string;
}

function split(domain: string): { sld: string; tld: string } {
    const i = domain.indexOf(".");
    return { sld: domain.slice(0, i), tld: domain.slice(i + 1) };
}

/** Namecheap dates look like 03/25/2027. */
function isoDate(s: string | undefined): string {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s ?? "");
    return m ? `${m[3]}-${m[1]}-${m[2]}` : "";
}

export class NamecheapAdapter implements RegistrarAdapter {
    kind = "namecheap" as const;
    features = REGISTRAR_FEATURES.namecheap;
    private user: string;
    private key: string;
    private ip: string;

    constructor(secret: string) {
        const c = parseCreds(secret, ["api_user", "api_key", "client_ip"], "Namecheap");
        this.user = c.api_user;
        this.key = c.api_key;
        this.ip = c.client_ip;
    }

    private async call(command: string, params: Record<string, string | number> = {}): Promise<XmlNode> {
        const form = new URLSearchParams({
            ApiUser: this.user,
            ApiKey: this.key,
            UserName: this.user,
            ClientIp: this.ip,
            Command: command,
        });
        for (const [k, v] of Object.entries(params)) form.set(k, String(v));

        const { status, text } = await http(BASE, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: form.toString(),
        });

        const root = parseXml(text);
        if (root.name !== "ApiResponse") {
            throw new RegistrarError(`Namecheap API error (${status})`, status >= 400 ? status : 502);
        }
        if (root.attrs.Status === "OK") return root;

        const err = descendants(root, "Error")[0];
        const message = textOf(err) || "Namecheap rejected the request.";
        const auth = /\bIP\b|api key|api user|apiuser|api access|username|whitelist|not authori[sz]ed/i.test(message);
        const limited = /too many|rate limit/i.test(message);
        throw new RegistrarError(message, auth ? 401 : limited ? 429 : 400, err?.attrs.Number ?? "");
    }

    async verify() {
        await this.call("namecheap.users.getBalances");
    }

    isAuthError(e: unknown) {
        return e instanceof RegistrarError && e.isAuth;
    }
    isTransient(e: unknown) {
        return e instanceof RegistrarError && e.isTransient;
    }
    describeError(e: unknown) {
        return e instanceof RegistrarError ? `Namecheap: ${e.message}` : null;
    }

    async domains(): Promise<DomainSummary[]> {
        const out: DomainSummary[] = [];

        for (let page = 1; ; page++) {
            const root = await this.call("namecheap.domains.getList", { Page: page, PageSize: 100, SortBy: "NAME" });
            const rows = descendants(root, "Domain");

            for (const d of rows) {
                const a = d.attrs;
                out.push({
                    id: a.Name,
                    name: a.Name,
                    status: a.IsExpired === "true" ? "expired" : "active",
                    expires: isoDate(a.Expires),
                    autoRenew: a.AutoRenew === undefined ? null : a.AutoRenew === "true",
                    locked: a.IsLocked === undefined ? null : a.IsLocked === "true",
                });
            }

            const total = Number(valueOf(root, "TotalItems")) || 0;
            if (rows.length === 0 || page * 100 >= total) break;
        }
        return out.sort((a, b) => a.name.localeCompare(b.name));
    }

    private async hosts(domain: string): Promise<Host[]> {
        const { sld, tld } = split(domain);
        const root = await this.call("namecheap.domains.dns.getHosts", { SLD: sld, TLD: tld });
        return descendants(root, "host").map((h) => ({
            name: h.attrs.Name,
            type: h.attrs.Type,
            address: h.attrs.Address,
            mxPref: h.attrs.MXPref ?? "",
            ttl: h.attrs.TTL ?? "1800",
        }));
    }

    private async save(domain: string, rows: Host[]) {
        const { sld, tld } = split(domain);
        const params: Record<string, string> = { SLD: sld, TLD: tld };
        rows.forEach((r, i) => {
            const n = i + 1;
            params[`HostName${n}`] = r.name;
            params[`RecordType${n}`] = r.type;
            params[`Address${n}`] = r.address;
            params[`MXPref${n}`] = r.mxPref || "10";
            params[`TTL${n}`] = r.ttl;
        });
        await this.call("namecheap.domains.dns.setHosts", params);
    }

    private toRecord(h: Host): DnsRecord {
        return {
            id: encodeRef([h.type, h.name, h.address]),
            type: h.type,
            name: h.name,
            value: h.address,
            ttl: Number(h.ttl),
            priority: h.type === "MX" ? Number(h.mxPref) || 10 : null,
        };
    }

    private fromInput(input: DnsRecordInput): Host {
        return {
            name: input.name,
            type: input.type,
            address: input.value,
            mxPref: input.priority === null ? "" : String(input.priority),
            ttl: String(Math.min(Math.max(input.ttl, 60), 60000)),
        };
    }

    async records(domain: string) {
        return (await this.hosts(domain)).map((h) => this.toRecord(h));
    }

    async addRecord(domain: string, input: DnsRecordInput) {
        const rows = await this.hosts(domain);
        const row = this.fromInput(input);
        rows.push(row);
        await this.save(domain, rows);
        return this.toRecord(row);
    }

    async updateRecord(domain: string, id: string, input: DnsRecordInput) {
        const [type, name, value] = decodeRef(id, 3);
        const rows = await this.hosts(domain);
        const i = rows.findIndex((r) => r.type === type && r.name === name && r.address === value);
        if (i < 0) throw new RegistrarError("Namecheap couldn't find that record.", 404);

        const row = this.fromInput(input);
        rows[i] = row;
        await this.save(domain, rows);
        return this.toRecord(row);
    }

    async removeRecord(domain: string, id: string) {
        const [type, name, value] = decodeRef(id, 3);
        const rows = await this.hosts(domain);
        const i = rows.findIndex((r) => r.type === type && r.name === name && r.address === value);
        if (i < 0) return; // already gone

        rows.splice(i, 1);
        await this.save(domain, rows);
    }

    async nameservers(domain: string) {
        const { sld, tld } = split(domain);
        const root = await this.call("namecheap.domains.dns.getList", { SLD: sld, TLD: tld });
        return descendants(root, "Nameserver").map((n) => textOf(n));
    }

    async setNameservers(domain: string, servers: string[]) {
        const { sld, tld } = split(domain);
        await this.call("namecheap.domains.dns.setCustom", { SLD: sld, TLD: tld, Nameservers: servers.join(",") });
    }

    async billing(): Promise<BillingSummary> {
        const root = await this.call("namecheap.users.getBalances");
        const a = descendants(root, "UserGetBalancesResult")[0]?.attrs ?? {};
        const amount = Number(a.AvailableBalance);
        return {
            balance: Number.isFinite(amount) ? { amount, currency: (a.Currency || "USD").toUpperCase() } : null,
            lines: [],
        };
    }
}