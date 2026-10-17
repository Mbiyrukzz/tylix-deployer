/**
 * Dynadot (https://www.dynadot.com/domain/api3.html)
 *
 *   - Credentials: { api_key } as JSON. GET https://api.dynadot.com/api3.json?key=...&command=...
 *     If the key is restricted by IP in Dynadot's tools, allow this server's IP.
 *   - Domain id = the domain name.
 *   - Features: domains, dns, nameservers, billing (balance from account_info). No billing history.
 *   - DNS: get_dns returns main-domain records and subdomain records; set_dns2 REPLACES
 *     THE WHOLE ZONE. So add/update/remove read the zone, change one row, and write
 *     every row back, behind these gates (see writeZone):
 *       - the get_dns response must be recognised, and the domain must use Dynadot DNS
 *       - only A / AAAA / CNAME / MX / TXT / NS rows may exist (FORWARD, STEALTH and
 *         EMAIL rows are listed but block edits: they can't be rewritten losslessly)
 *       - never an empty zone
 *       - the old zone is logged before the write, and the row count is re-read after it
 *     Records have no id, so the id handed out is encodeRef([type, sub, value, pref]).
 *     TTL is zone-wide: the TTL of the record being saved becomes the zone's TTL.
 *
 * VERIFY BEFORE USE: every response shape and set_dns2 parameter name below is from
 * memory (NameServerSettings / MainDomains / SubDomains / Subhost / RecordType / Value /
 * Value2, and main_record_type0 / main_record0 / main_recordx0 / subdomain0 /
 * sub_record_type0 / sub_record0 / sub_recordx0 / ttl). Run it against a throwaway
 * domain, and keep the server log open for the snapshot line.
 */

import {
    type BillingSummary,
    type DnsRecord,
    type DnsRecordInput,
    type DomainSummary,
    type RegistrarAdapter,
    REGISTRAR_FEATURES,
} from "../RegistrarAdapter.js";
import { decodeRef, encodeRef, http, parseCreds, RegistrarError, type Json } from "./http.js";

const BASE = "https://api.dynadot.com/api3.json";

/** Record types a zone rewrite can carry without loss. */
const SAFE_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS"]);

/** A GET URL longer than this risks being cut off by a proxy. */
const MAX_URL = 7000;

interface ZoneRow {
    /** "@" for the apex, otherwise the subdomain host. */
    sub: string;
    type: string;
    value: string;
    /** MX distance, "" for other types. */
    pref: string;
}

interface Zone {
    ttl: number;
    rows: ZoneRow[];
}

/** Every string stored under one of `keys`, anywhere in the response. */
function collect(node: Json, keys: string[], out: string[] = []): string[] {
    if (Array.isArray(node)) {
        node.forEach((n) => collect(n, keys, out));
    } else if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
            if (typeof v === "string" && v && keys.includes(k)) out.push(v);
            else collect(v, keys, out);
        }
    }
    return out;
}

/** First value stored under `key`, anywhere in the response. */
function locate(node: Json, key: string): Json | null {
    if (!node || typeof node !== "object") return null;
    if (!Array.isArray(node) && key in node) return node[key];
    for (const v of Object.values(node)) {
        const found = locate(v, key);
        if (found !== null && found !== undefined) return found;
    }
    return null;
}

function isoDate(raw: unknown): string {
    if (raw === undefined || raw === null || raw === "") return "";
    if (typeof raw === "number" || /^\d+$/.test(String(raw))) {
        const n = Number(raw);
        return new Date(n < 1e12 ? n * 1000 : n).toISOString().slice(0, 10);
    }
    return String(raw).slice(0, 10);
}

export class DynadotAdapter implements RegistrarAdapter {
    kind = "dynadot" as const;
    features = REGISTRAR_FEATURES.dynadot;
    private key: string;

    constructor(secret: string) {
        this.key = parseCreds(secret, ["api_key"], "Dynadot").api_key;
    }

    private async call(command: string, params: Record<string, string> = {}): Promise<Json> {
        const q = new URLSearchParams({ key: this.key, command, ...params });
        const url = `${BASE}?${q}`;
        if (url.length > MAX_URL) {
            throw new RegistrarError("This request is too large for Dynadot's API. Edit this zone in Dynadot instead.", 422);
        }

        const { status, data } = await http(url, { method: "GET" });

        if (!data || typeof data !== "object" || Object.keys(data).length === 0) {
            throw new RegistrarError("Dynadot returned an unreadable response.", status >= 400 ? status : 502);
        }

        const root: Json = Object.values(data)[0] ?? {};
        const head: Json = root.ResponseHeader ?? root;
        const code =
            head.ResponseCode !== undefined
                ? Number(head.ResponseCode)
                : head.Status
                  ? /success/i.test(String(head.Status))
                      ? 0
                      : -1
                  : 0;

        if (status < 400 && code === 0) return root;

        const message = String(head.Error ?? root.Error ?? head.Status ?? `Dynadot API error (${status})`);
        const auth =
            status === 401 || status === 403 || /\bkey\b|\bIP\b|denied|unauthori[sz]ed|not allowed|whitelist/i.test(message);
        throw new RegistrarError(message, auth ? 401 : status >= 400 ? status : 400);
    }

    async verify() {
        await this.call("account_info");
    }

    isAuthError(e: unknown) {
        return e instanceof RegistrarError && e.isAuth;
    }
    isTransient(e: unknown) {
        return e instanceof RegistrarError && e.isTransient;
    }
    describeError(e: unknown) {
        return e instanceof RegistrarError ? `Dynadot: ${e.message}` : null;
    }

    async domains(): Promise<DomainSummary[]> {
        const root = await this.call("domain_list");
        const list: Json[] = root.Content?.Domains ?? root.DomainListContent?.Domains ?? root.MainDomains ?? root.Domains ?? [];

        return list
            .map((item) => {
                const d: Json = item?.Domain ?? item;
                const name = String(d.Name ?? d.DomainName ?? "");
                const locked = String(d.Locked ?? "").toLowerCase();
                return {
                    id: name,
                    name,
                    status: "active",
                    expires: isoDate(d.Expiration ?? d.ExpirationDate),
                    autoRenew: null,
                    locked: locked === "yes" ? true : locked === "no" ? false : null,
                } as DomainSummary;
            })
            .filter((d) => d.name)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    // ---- DNS ----

    /** Reads the zone. Throws (422) when the response isn't recognised or the domain doesn't use Dynadot DNS. */
    private async zone(domain: string): Promise<Zone> {
        const root = await this.call("get_dns", { domain });
        const settings: Json = locate(root, "NameServerSettings");

        if (!settings || typeof settings !== "object") {
            throw new RegistrarError(
                "Dynadot returned DNS settings in a shape this adapter doesn't recognise, so DNS editing is switched off for safety.",
                422,
            );
        }

        const type = settings.Type;
        if (typeof type === "string" && type && !/dynadot dns/i.test(type)) {
            throw new RegistrarError(
                `${domain} doesn't use Dynadot DNS (it is set to "${type}"). Change its nameservers first, or manage DNS where it is hosted.`,
                422,
            );
        }

        const rows: ZoneRow[] = [];

        for (const m of Array.isArray(settings.MainDomains) ? settings.MainDomains : []) {
            rows.push({ sub: "@", type: String(m.RecordType ?? "").toUpperCase(), value: String(m.Value ?? ""), pref: String(m.Value2 ?? "") });
        }
        for (const s of Array.isArray(settings.SubDomains) ? settings.SubDomains : []) {
            rows.push({
                sub: String(s.Subhost ?? "").toLowerCase(),
                type: String(s.RecordType ?? "").toUpperCase(),
                value: String(s.Value ?? ""),
                pref: String(s.Value2 ?? ""),
            });
        }

        return { ttl: Number(settings.TTL) || 300, rows };
    }

    private toRecord(r: ZoneRow, ttl: number): DnsRecord {
        return {
            id: encodeRef([r.type, r.sub, r.value, r.pref]),
            type: r.type,
            name: r.sub,
            value: r.value,
            ttl,
            priority: r.type === "MX" ? Number(r.pref) || 10 : null,
        };
    }

    private fromInput(input: DnsRecordInput): ZoneRow {
        return {
            sub: input.name.toLowerCase(),
            type: input.type.toUpperCase(),
            value: input.value,
            pref: input.type.toUpperCase() === "MX" ? String(input.priority ?? 10) : "",
        };
    }

    private indexOf(rows: ZoneRow[], ref: string[]): number {
        const [type, sub, value, pref] = ref;
        return rows.findIndex((r) => r.type === type && r.sub === sub && r.value === value && r.pref === pref);
    }

    /** The one place that calls set_dns2. Every write goes through here. */
    private async writeZone(domain: string, before: Zone, rows: ZoneRow[], ttl: number) {
        const odd = before.rows.find((r) => !SAFE_TYPES.has(r.type));
        if (odd) {
            throw new RegistrarError(
                `This zone has a ${odd.type} record, which can't be rewritten safely from here. Edit this zone in Dynadot.`,
                422,
            );
        }
        if (rows.length === 0) {
            throw new RegistrarError("Dynadot needs at least one record in a zone. Remove the last one in Dynadot itself.", 422);
        }

        console.info(`[dynadot] zone snapshot before change for ${domain}:`, JSON.stringify(before));

        const params: Record<string, string> = { domain, ttl: String(ttl) };
        let main = 0;
        let sub = 0;

        for (const r of rows) {
            const type = r.type.toLowerCase();
            if (r.sub === "@") {
                params[`main_record_type${main}`] = type;
                params[`main_record${main}`] = r.value;
                if (r.type === "MX") params[`main_recordx${main}`] = r.pref || "10";
                main++;
            } else {
                params[`subdomain${sub}`] = r.sub;
                params[`sub_record_type${sub}`] = type;
                params[`sub_record${sub}`] = r.value;
                if (r.type === "MX") params[`sub_recordx${sub}`] = r.pref || "10";
                sub++;
            }
        }

        await this.call("set_dns2", params);

        const after = await this.zone(domain);
        if (after.rows.length !== rows.length) {
            console.error(`[dynadot] ${domain}: wrote ${rows.length} records, zone now has ${after.rows.length}. Snapshot was logged above.`);
            throw new RegistrarError(
                `Dynadot saved ${after.rows.length} records instead of the ${rows.length} requested. Check the zone in Dynadot now.`,
                502,
            );
        }
    }

    async records(domain: string): Promise<DnsRecord[]> {
        const z = await this.zone(domain);
        return z.rows.map((r) => this.toRecord(r, z.ttl));
    }

    async addRecord(domain: string, input: DnsRecordInput): Promise<DnsRecord> {
        const z = await this.zone(domain);
        const row = this.fromInput(input);
        await this.writeZone(domain, z, [...z.rows, row], input.ttl);
        return this.toRecord(row, input.ttl);
    }

    async updateRecord(domain: string, id: string, input: DnsRecordInput): Promise<DnsRecord> {
        const z = await this.zone(domain);
        const i = this.indexOf(z.rows, decodeRef(id, 4));
        if (i < 0) throw new RegistrarError("Dynadot couldn't find that record.", 404);

        const row = this.fromInput(input);
        const rows = [...z.rows];
        rows[i] = row;
        await this.writeZone(domain, z, rows, input.ttl);
        return this.toRecord(row, input.ttl);
    }

    async removeRecord(domain: string, id: string): Promise<void> {
        const z = await this.zone(domain);
        const i = this.indexOf(z.rows, decodeRef(id, 4));
        if (i < 0) return; // already gone

        await this.writeZone(domain, z, z.rows.filter((_, n) => n !== i), z.ttl);
    }

    // ---- nameservers ----

    async nameservers(domain: string) {
        const root = await this.call("get_ns", { domain });
        return [...new Set(collect(root, ["ServerName", "NameServer"]))];
    }

    async setNameservers(domain: string, servers: string[]) {
        const params: Record<string, string> = { domain };
        servers.forEach((s, i) => {
            params[`ns${i}`] = s;
        });
        await this.call("set_ns", params);
    }

    // ---- billing: balance only ----

    async billing(): Promise<BillingSummary> {
        const root = await this.call("account_info");
        const info: Json = root.Content?.AccountInfo ?? root.AccountInfo ?? root;

        const list: Json = info.balance_list ?? info.BalanceList;
        if (Array.isArray(list) && list.length > 0) {
            const row: Json = list.find((b: Json) => /usd/i.test(String(b.currency ?? b.Currency))) ?? list[0];
            const amount = Number(row.amount ?? row.Amount);
            if (Number.isFinite(amount)) {
                return { balance: { amount, currency: String(row.currency ?? row.Currency ?? "USD").toUpperCase() }, lines: [] };
            }
        }

        const flat = parseFloat(String(info.account_balance ?? info.AccountBalance ?? "").replace(/[^0-9.\-]/g, ""));
        return { balance: Number.isFinite(flat) ? { amount: flat, currency: "USD" } : null, lines: [] };
    }
}