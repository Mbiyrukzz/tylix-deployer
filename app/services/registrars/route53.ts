/**
 * Route 53 + Route 53 Domains (AWS), signed by hand in aws.ts.
 *
 *   - Credentials: { api_key = access key ID, secret_key = secret access key } as JSON.
 *   - Two services in one adapter:
 *       Route 53 Domains (JSON 1.1, route53domains.us-east-1): domain list, expiry,
 *         auto-renew, transfer lock, registered nameservers, billing records.
 *       Route 53 (REST + XML): DNS, in HOSTED ZONES. The domain id is the domain name;
 *         its public hosted zone is looked up by name.
 *   - domains() is registered domains UNION public hosted zones, so a domain whose DNS
 *     lives here but is registered elsewhere still shows (status "dns-only", no expiry).
 *   - A Route 53 record set is (name, type) with SEVERAL values and ONE ttl. Each value
 *     becomes one DnsRecord; the id is encodeRef([type, fqdn, raw value]). Writes read the
 *     current set, change one value, and UPSERT the whole set (DELETE when it empties).
 *     Changing the TTL of one record changes the TTL of every value in its set.
 *   - Alias records and SOA are not listed (they can't be edited as plain values).
 *   - verify() calls STS GetCallerIdentity: it needs no permissions, so it proves the keys
 *     are valid, NOT that the IAM user may touch Route 53. Missing permissions show up
 *     later as a 403 "missing_access" with AWS's own message.
 *
 * IAM needed: route53:ListHostedZones, route53:ListResourceRecordSets,
 * route53:ChangeResourceRecordSets, route53:GetHostedZone, route53domains:ListDomains,
 * route53domains:GetDomainDetail, route53domains:ViewBilling,
 * route53domains:UpdateDomainNameservers, route53domains:Enable/DisableDomainAutoRenew,
 * route53domains:Enable/DisableDomainTransferLock.
 *
 * VERIFY BEFORE USE: ViewBilling field names (BillingRecords, BillDate, Price) and the
 * wildcard handling (\052) are from memory. Try a throwaway zone first.
 */

import {
    type BillingLine,
    type BillingSummary,
    type DnsRecord,
    type DnsRecordInput,
    type DomainSummary,
    type RegistrarAdapter,
    REGISTRAR_FEATURES,
} from "../RegistrarAdapter.js";
import { decodeRef, encodeRef, http, parseCreds, RegistrarError, relName, type Json } from "./http.js";
import { awsError, awsRequest, type AwsKeys } from "./aws.js";
import { descendants, kid, kids, parseXml, textOf, valueOf, type XmlNode } from "./xml.js";

const DOMAINS_HOST = "route53domains.us-east-1.amazonaws.com";
const ZONES_HOST = "route53.amazonaws.com";
const API = "/2013-04-01";

interface RrSet {
    /** Decoded, lower-case, no trailing dot ("*" for wildcards). */
    name: string;
    type: string;
    ttl: number;
    values: string[];
    alias: boolean;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Route 53 returns "\052" for "*" and other octal escapes. */
const decodeName = (n: string) =>
    n
        .replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
        .replace(/\.$/, "")
        .toLowerCase();

/** The same name as a list query wants it. */
const wire = (n: string) => n.replace(/\*/g, "\\052");

function unquote(raw: string): string {
    const parts = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1"));
    return parts.length ? parts.join("") : raw;
}

function quote(value: string): string {
    const chunks = value.match(/[\s\S]{1,255}/g) ?? [""];
    return chunks.map((c) => `"${c.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" ");
}

function parseSets(root: XmlNode): RrSet[] {
    return descendants(root, "ResourceRecordSet").map((n) => ({
        name: decodeName(textOf(kid(n, "Name"))),
        type: textOf(kid(n, "Type")),
        ttl: Number(textOf(kid(n, "TTL")) || 300),
        values: kids(kid(n, "ResourceRecords"), "ResourceRecord").map((r) => textOf(kid(r, "Value"))),
        alias: Boolean(kid(n, "AliasTarget")),
    }));
}

export class Route53Adapter implements RegistrarAdapter {
    kind = "route53" as const;
    features = REGISTRAR_FEATURES.route53;
    private keys: AwsKeys;
    private zoneIds = new Map<string, string>();

    constructor(secret: string) {
        const c = parseCreds(secret, ["api_key", "secret_key"], "Route 53");
        this.keys = { accessKeyId: c.api_key, secretAccessKey: c.secret_key };
    }

    // ---- transport ----

    private async domainsCall(action: string, body: Record<string, unknown> = {}): Promise<Json> {
        const { status, data, text } = await awsRequest({
            keys: this.keys,
            service: "route53domains",
            host: DOMAINS_HOST,
            method: "POST",
            path: "/",
            body: JSON.stringify(body),
            headers: {
                "content-type": "application/x-amz-json-1.1",
                "x-amz-target": `Route53Domains_v20140515.${action}`,
            },
        });
        if (status < 400) return data;
        throw awsError(status, data, text);
    }

    private async zoneCall(method: string, path: string, query?: Record<string, string>, xml?: string): Promise<XmlNode> {
        const { status, data, text } = await awsRequest({
            keys: this.keys,
            service: "route53",
            host: ZONES_HOST,
            method,
            path: API + path,
            query,
            body: xml,
            headers: xml ? { "content-type": "text/xml" } : {},
        });
        if (status >= 400) throw awsError(status, data, text);
        return parseXml(text);
    }

    async verify() {
        const { status, data, text } = await awsRequest({
            keys: this.keys,
            service: "sts",
            host: "sts.amazonaws.com",
            method: "POST",
            path: "/",
            body: "Action=GetCallerIdentity&Version=2011-06-15",
            headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
        });
        if (status >= 400) throw awsError(status, data, text);
    }

    isAuthError(e: unknown) {
        return e instanceof RegistrarError && e.isAuth;
    }
    isTransient(e: unknown) {
        return e instanceof RegistrarError && e.isTransient;
    }
    describeError(e: unknown) {
        return e instanceof RegistrarError ? `Route 53: ${e.message}` : null;
    }

    // ---- domains ----

    private async loadZones(): Promise<{ id: string; name: string }[]> {
        const out: { id: string; name: string }[] = [];
        let marker = "";

        for (let guard = 0; guard < 100; guard++) {
            const root = await this.zoneCall("GET", "/hostedzone", { maxitems: "100", ...(marker ? { marker } : {}) });

            for (const z of descendants(root, "HostedZone")) {
                if (valueOf(z, "PrivateZone") === "true") continue;
                const name = textOf(kid(z, "Name")).replace(/\.$/, "").toLowerCase();
                const id = textOf(kid(z, "Id")).replace("/hostedzone/", "");
                if (!this.zoneIds.has(name)) this.zoneIds.set(name, id);
                out.push({ id, name });
            }

            marker = valueOf(root, "IsTruncated") === "true" ? valueOf(root, "NextMarker") : "";
            if (!marker) break;
        }
        return out;
    }

    private async registered(): Promise<DomainSummary[]> {
        const out: DomainSummary[] = [];
        let marker = "";

        do {
            const data = await this.domainsCall("ListDomains", { MaxItems: 100, ...(marker ? { Marker: marker } : {}) });
            for (const d of (data.Domains ?? []) as Json[]) {
                out.push({
                    id: String(d.DomainName),
                    name: String(d.DomainName),
                    status: "registered",
                    expires: d.Expiry ? new Date(Number(d.Expiry) * 1000).toISOString().slice(0, 10) : "",
                    autoRenew: typeof d.AutoRenew === "boolean" ? d.AutoRenew : null,
                    locked: typeof d.TransferLock === "boolean" ? d.TransferLock : null,
                });
            }
            marker = data.NextPageMarker ? String(data.NextPageMarker) : "";
        } while (marker);

        return out;
    }

    async domains(): Promise<DomainSummary[]> {
        const [reg, zones] = await Promise.allSettled([this.registered(), this.loadZones()]);
        if (reg.status === "rejected" && zones.status === "rejected") throw reg.reason;

        const byName = new Map<string, DomainSummary>();

        if (zones.status === "fulfilled") {
            for (const z of zones.value) {
                byName.set(z.name, { id: z.name, name: z.name, status: "dns-only", expires: "", autoRenew: null, locked: null });
            }
        }
        if (reg.status === "fulfilled") {
            for (const d of reg.value) byName.set(d.name.toLowerCase(), { ...d, id: d.name.toLowerCase(), name: d.name.toLowerCase() });
        }
        return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    private async zoneId(domain: string): Promise<string> {
        const key = domain.toLowerCase();
        if (!this.zoneIds.has(key)) await this.loadZones();

        const id = this.zoneIds.get(key);
        if (!id) throw new RegistrarError(`No public hosted zone for ${domain} in Route 53. Create one there first.`, 422);
        return id;
    }

    // ---- DNS ----

    private fqdn(domain: string, name: string): string {
        return (name === "@" ? domain : `${name}.${domain}`).toLowerCase();
    }

    private rawValue(input: DnsRecordInput): string {
        if (input.type === "MX") return `${input.priority ?? 10} ${input.value}`;
        if (input.type === "TXT") return quote(input.value);
        return input.value;
    }

    private expand(domain: string, s: RrSet): DnsRecord[] {
        return s.values.map((raw) => {
            let value = raw;
            let priority: number | null = null;

            if (s.type === "MX") {
                const [p, ...rest] = raw.split(/\s+/);
                priority = Number(p);
                value = rest.join(" ").replace(/\.$/, "");
            } else if (s.type === "TXT") {
                value = unquote(raw);
            } else if (s.type === "CNAME" || s.type === "NS") {
                value = raw.replace(/\.$/, "");
            }

            return {
                id: encodeRef([s.type, s.name, raw]),
                type: s.type,
                name: relName(s.name, domain),
                value,
                ttl: s.ttl,
                priority,
            };
        });
    }

    private async currentSet(zoneId: string, fqdn: string, type: string): Promise<RrSet | null> {
        const root = await this.zoneCall("GET", `/hostedzone/${zoneId}/rrset`, { name: wire(fqdn), type, maxitems: "1" });
        const s = parseSets(root)[0];
        return s && s.name === fqdn && s.type === type ? s : null;
    }

    private async change(
        zoneId: string,
        action: "UPSERT" | "DELETE",
        set: { name: string; type: string; ttl: number; values: string[] },
    ) {
        const xml =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch><Changes><Change>` +
            `<Action>${action}</Action><ResourceRecordSet>` +
            `<Name>${esc(set.name)}</Name><Type>${set.type}</Type><TTL>${set.ttl}</TTL>` +
            `<ResourceRecords>${set.values.map((v) => `<ResourceRecord><Value>${esc(v)}</Value></ResourceRecord>`).join("")}</ResourceRecords>` +
            `</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`;

        await this.zoneCall("POST", `/hostedzone/${zoneId}/rrset`, undefined, xml);
    }

    async records(domain: string): Promise<DnsRecord[]> {
        const zoneId = await this.zoneId(domain);
        const out: DnsRecord[] = [];
        let next: { name: string; type: string } | null = null;

        for (let guard = 0; guard < 100; guard++) {
            const root: XmlNode = await this.zoneCall("GET", `/hostedzone/${zoneId}/rrset`, {
                maxitems: "300",
                ...(next ? { name: wire(next.name), type: next.type } : {}),
            });

            for (const s of parseSets(root)) {
                if (s.alias || s.type === "SOA") continue;
                out.push(...this.expand(domain, s));
            }

            if (valueOf(root, "IsTruncated") !== "true") break;
            next = { name: valueOf(root, "NextRecordName"), type: valueOf(root, "NextRecordType") };
            if (!next.name) break;
        }
        return out;
    }

    async addRecord(domain: string, input: DnsRecordInput): Promise<DnsRecord> {
        const zoneId = await this.zoneId(domain);
        const name = this.fqdn(domain, input.name);
        const raw = this.rawValue(input);
        const cur = await this.currentSet(zoneId, name, input.type);

        if (!cur || !cur.values.includes(raw)) {
            await this.change(zoneId, "UPSERT", { name, type: input.type, ttl: input.ttl, values: [...(cur?.values ?? []), raw] });
        }
        return { id: encodeRef([input.type, name, raw]), type: input.type, name: input.name, value: input.value, ttl: input.ttl, priority: input.priority };
    }

    async updateRecord(domain: string, id: string, input: DnsRecordInput): Promise<DnsRecord> {
        const [type, name, oldRaw] = decodeRef(id, 3);
        const newName = this.fqdn(domain, input.name);

        if (type !== input.type || name !== newName) {
            await this.removeRecord(domain, id);
            return this.addRecord(domain, input);
        }

        const zoneId = await this.zoneId(domain);
        const cur = await this.currentSet(zoneId, name, type);
        if (!cur || !cur.values.includes(oldRaw)) throw new RegistrarError("Route 53 couldn't find that record.", 404);

        const raw = this.rawValue(input);
        await this.change(zoneId, "UPSERT", { name, type, ttl: input.ttl, values: cur.values.map((v) => (v === oldRaw ? raw : v)) });
        return { id: encodeRef([type, name, raw]), type, name: input.name, value: input.value, ttl: input.ttl, priority: input.priority };
    }

    async removeRecord(domain: string, id: string): Promise<void> {
        const [type, name, raw] = decodeRef(id, 3);
        const zoneId = await this.zoneId(domain);
        const cur = await this.currentSet(zoneId, name, type);
        if (!cur || !cur.values.includes(raw)) return; // already gone

        const rest = cur.values.filter((v) => v !== raw);
        if (rest.length === 0) {
            // DELETE must match the current set exactly, TTL included.
            await this.change(zoneId, "DELETE", { name, type, ttl: cur.ttl, values: cur.values });
        } else {
            await this.change(zoneId, "UPSERT", { name, type, ttl: cur.ttl, values: rest });
        }
    }

    // ---- nameservers ----

    async nameservers(domain: string): Promise<string[]> {
        try {
            const d = await this.domainsCall("GetDomainDetail", { DomainName: domain });
            const ns = ((d.Nameservers ?? []) as Json[]).map((n) => String(n.Name));
            if (ns.length > 0) return ns;
        } catch (error) {
            if (!(error instanceof RegistrarError)) throw error;
            // not registered here: fall back to the hosted zone's delegation set
        }
        const root = await this.zoneCall("GET", `/hostedzone/${await this.zoneId(domain)}`);
        return descendants(root, "NameServer").map((n) => textOf(n));
    }

    async setNameservers(domain: string, servers: string[]) {
        await this.domainsCall("UpdateDomainNameservers", { DomainName: domain, Nameservers: servers.map((Name) => ({ Name })) });
    }

    // ---- settings ----

    async setAutoRenew(domain: string, on: boolean) {
        await this.domainsCall(on ? "EnableDomainAutoRenew" : "DisableDomainAutoRenew", { DomainName: domain });
    }

    async setLock(domain: string, on: boolean) {
        await this.domainsCall(on ? "EnableDomainTransferLock" : "DisableDomainTransferLock", { DomainName: domain });
    }

    // ---- billing: the last 12 months of Route 53 Domains charges ----

    async billing(): Promise<BillingSummary> {
        const end = Math.floor(Date.now() / 1000);
        const start = end - 365 * 86_400;
        const lines: BillingLine[] = [];
        let marker = "";

        for (let page = 0; page < 10; page++) {
            const data = await this.domainsCall("ViewBilling", { Start: start, End: end, MaxItems: 100, ...(marker ? { Marker: marker } : {}) });

            for (const r of (data.BillingRecords ?? []) as Json[]) {
                const op = String(r.Operation ?? "").replace(/_/g, " ").toLowerCase();
                lines.push({
                    id: String(r.InvoiceId ?? `${r.DomainName}-${r.BillDate}`),
                    date: r.BillDate ? new Date(Number(r.BillDate) * 1000).toISOString().slice(0, 10) : "",
                    description: `${op} ${r.DomainName ?? ""}`.trim(),
                    amount: Number(r.Price ?? 0),
                    currency: "USD",
                });
            }

            marker = data.NextPageMarker ? String(data.NextPageMarker) : "";
            if (!marker) break;
        }

        return { balance: null, lines: lines.sort((a, b) => b.date.localeCompare(a.date)) };
    }
}