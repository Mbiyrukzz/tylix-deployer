/**
 * Service: ProviderManage
 *
 * Domains (DNS) and account billing for the providers that support them.
 * Kept separate from ProviderAdapter so the provisioning code is untouched.
 *
 *   Linode:  /domains + /domains/:id/records, /account + /account/invoices
 *            Token scopes: Domains: Read/Write, Account: Read Only.
 *   Hetzner: /zones + /zones/:id/rrsets (the Cloud API now includes DNS).
 *            Hetzner has NO billing endpoint, so billing() is an estimate
 *            built from the project's servers and the server-type price list.
 *
 * Differences this hides:
 *   - Linode has one row per record. Hetzner groups records into RRSets
 *     (same name + type), so we flatten them. A Hetzner record id is
 *     base64url(JSON [name, type, rawValue]), which is safe in a URL.
 *   - The zone apex is "@" everywhere outside this file. Linode uses "".
 *   - Hetzner wants TXT values quoted, MX as "<priority> <host>", and
 *     hostnames as FQDNs with a trailing dot. toWire()/hzRecord() convert.
 *   - Hetzner's TTL belongs to the RRSet, so changing it changes every
 *     value with the same name and type.
 */

const TIMEOUT_MS = 20_000;
const PER_PAGE = 100;
const MAX_PAGES = 50;

export const MANAGE_KINDS = ["linode", "hetzner"];

/** Shown when a token is rejected for domains/billing calls. */
export const ACCESS_HELP: Record<string, string> = {
    linode:
        "This Linode token can't use Domains or Account. Create a new personal access token with Domains: Read/Write and Account: Read Only (keep Linodes: Read/Write), then Edit this connection and paste it.",
    hetzner:
        "This Hetzner token can't change DNS. Create a project API token with Read & Write permission (Security → API tokens), then Edit this connection and paste it.",
};

export class ManageError extends Error {
    status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = "ManageError";
        this.status = status;
    }
}

export interface ManagedDomain {
    id: string;
    name: string;
    status: string;
    mode: string;
    email: string;
    ttl: number;
    recordCount: number | null;
}

export interface DnsRecord {
    id: string;
    type: string;
    /** "@" for the zone apex. SRV shows "_service._protocol". */
    name: string;
    value: string;
    /** 0 means "provider default". */
    ttl: number;
    priority: number | null;
    weight: number | null;
    port: number | null;
    service: string;
    protocol: string;
    tag: string;
    /** Records the UI must not edit or delete (apex NS, SOA). */
    locked: boolean;
}

export interface RecordInput {
    type: string;
    name: string;
    value: string;
    ttl: number;
    priority: number | null;
    weight: number | null;
    port: number | null;
    service: string;
    protocol: string;
    tag: string;
}

export interface DomainSettings {
    email: string;
    ttl: number;
}

export interface InvoiceItem {
    label: string;
    from: string;
    to: string;
    amount: number;
    tax: number;
    total: number;
}

export interface BillingSummary {
    currency: "USD" | "EUR";
    estimated: boolean;
    note: string;
    balance: number | null;
    current: number | null;
    currentLabel: string;
    items: { label: string; amount: number }[];
    invoices: { id: string; label: string; date: string; total: number }[];
    payments: { id: string; date: string; amount: number }[];
    transfer: { usedGb: number; quotaGb: number } | null;
}

export interface ManageAdapter {
    kind: string;
    isAuthError(error: unknown): boolean;
    domains(): Promise<ManagedDomain[]>;
    getDomain(id: string): Promise<ManagedDomain>;
    createDomain(name: string, email: string): Promise<ManagedDomain>;
    updateDomain(id: string, settings: DomainSettings): Promise<ManagedDomain>;
    removeDomain(id: string): Promise<void>;
    records(domainId: string): Promise<DnsRecord[]>;
    addRecord(domainId: string, input: RecordInput): Promise<DnsRecord>;
    updateRecord(domainId: string, recordId: string, input: RecordInput): Promise<DnsRecord>;
    removeRecord(domainId: string, recordId: string): Promise<void>;
    billing(): Promise<BillingSummary>;
    invoiceItems?(invoiceId: string): Promise<InvoiceItem[]>;
}

// ---------------------------------------------------------------------------
// Shared HTTP
// ---------------------------------------------------------------------------

function describeNetworkFailure(error: unknown): string {
    const err = error as { name?: string; code?: string; cause?: { code?: string } } | null;

    if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timed out";

    const code = err?.cause?.code ?? err?.code;
    return code ? String(code) : "network error";
}

interface CallOptions {
    label: string;
    base: string;
    token: string;
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
    readError: (json: unknown, status: number) => string;
}

async function call<T>(o: CallOptions): Promise<T> {
    const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${o.token}`,
        ...(o.headers ?? {}),
    };
    if (o.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
        response = await fetch(`${o.base}${o.path}`, {
            method: o.method,
            headers,
            body: o.body === undefined ? undefined : JSON.stringify(o.body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        // Never include the request details here: they carry the token.
        throw new ManageError(
            `Could not reach the ${o.label} API (${describeNetworkFailure(error)}).`,
            0,
        );
    }

    const text = await response.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // Empty or non-JSON body (204s): json stays null.
    }

    if (!response.ok) {
        throw new ManageError(o.readError(json, response.status), response.status);
    }

    return json as T;
}

const isAuth = (error: unknown) =>
    error instanceof ManageError && (error.status === 401 || error.status === 403);

// ---------------------------------------------------------------------------
// Linode
// ---------------------------------------------------------------------------

const LINODE_BASE = "https://api.linode.com/v4";

interface LinodeDomainRaw {
    id: number;
    domain: string;
    type: string;
    status: string;
    soa_email: string;
    ttl_sec: number;
}

interface LinodeRecordRaw {
    id: number;
    type: string;
    name: string;
    target: string;
    priority: number;
    weight: number;
    port: number;
    service: string | null;
    protocol: string | null;
    tag: string | null;
    ttl_sec: number;
}


function linodeMessage(json: unknown, status: number): string {
    const errors = (json as { errors?: { field?: string; reason: string }[] } | null)?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
        return errors.map((e) => (e.field ? `${e.field}: ${e.reason}` : e.reason)).join(" ");
    }
    return `Linode API error (${status})`;
}

function fromLinodeDomain(d: LinodeDomainRaw): ManagedDomain {
    return {
        id: String(d.id),
        name: d.domain,
        status: d.status,
        mode: d.type,
        email: d.soa_email ?? "",
        ttl: d.ttl_sec ?? 0,
        recordCount: null,
    };
}


function fromLinodeRecord(r: LinodeRecordRaw): DnsRecord {
    const srv = r.type === "SRV";
    const service = (r.service ?? "").replace(/^_+/, "");
    const protocol = (r.protocol ?? "tcp").replace(/^_+/, "");

    return {
        id: String(r.id),
        type: r.type,
        name: srv ? `_${service}._${protocol}` : r.name === "" ? "@" : r.name,
        value: r.target,
        ttl: r.ttl_sec ?? 0,
        priority: r.type === "MX" || srv ? r.priority : null,
        weight: srv ? r.weight : null,
        port: srv ? r.port : null,
        service: srv ? service : "",
        protocol: srv ? protocol : "",
        tag: r.type === "CAA" ? (r.tag ?? "issue") : "",
        locked: r.type === "NS" && r.name === "",
    };
}
class LinodeManage implements ManageAdapter {
    kind = "linode";
    private token: string;

    constructor(token: string) {
        this.token = token;
    }

    private req<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
        return call<T>({
            label: "Linode",
            base: LINODE_BASE,
            token: this.token,
            method,
            path,
            body,
            headers,
            readError: linodeMessage,
        });
    }

    private async all<T>(path: string): Promise<T[]> {
        const out: T[] = [];
        const sep = path.includes("?") ? "&" : "?";

        for (let page = 1; page <= MAX_PAGES; page++) {
            const res = await this.req<{ data: T[]; pages: number }>(
                "GET",
                `${path}${sep}page=${page}&page_size=${PER_PAGE}`,
            );
            out.push(...(res.data ?? []));
            if (page >= (res.pages ?? 1)) break;
        }

        return out;
    }

    isAuthError = isAuth;

    async domains() {
        const rows = await this.all<LinodeDomainRaw>("/domains");
        return rows.map(fromLinodeDomain).sort((a, b) => a.name.localeCompare(b.name));
    }

    async getDomain(id: string) {
        return fromLinodeDomain(await this.req<LinodeDomainRaw>("GET", `/domains/${encodeURIComponent(id)}`));
    }

    async createDomain(name: string, email: string) {
        const raw = await this.req<LinodeDomainRaw>("POST", "/domains", {
            domain: name,
            type: "master",
            soa_email: email,
        });
        return fromLinodeDomain(raw);
    }

    async removeDomain(id: string) {
        try {
            await this.req("DELETE", `/domains/${encodeURIComponent(id)}`);
        } catch (error) {
            if (error instanceof ManageError && error.status === 404) return;
            throw error;
        }
    }

    async records(domainId: string) {
        const rows = await this.all<LinodeRecordRaw>(`/domains/${encodeURIComponent(domainId)}/records`);
        return rows.map(fromLinodeRecord);
    }

    private body(input: RecordInput, creating: boolean) {
        const body: Record<string, unknown> = {
            target: input.value,
            ttl_sec: input.ttl,
        };

        if (input.type === "SRV") {
            // For SRV the name is built from service + protocol, so no name is sent.
            body.service = input.service;
            body.protocol = input.protocol;
            body.priority = input.priority ?? 10;
            body.weight = input.weight ?? 0;
            body.port = input.port ?? 0;
        } else {
            body.name = input.name === "@" ? "" : input.name;
            if (input.type === "MX") body.priority = input.priority ?? 10;
            if (input.type === "CAA") body.tag = input.tag;
        }

        if (creating) body.type = input.type;
        return body;
    }

private async guard(domainId: string, recordId: string): Promise<boolean> {
        try {
            const r = await this.req<LinodeRecordRaw>(
                "GET",
                `/domains/${encodeURIComponent(domainId)}/records/${encodeURIComponent(recordId)}`,
            );

            if (r.type === "NS" && r.name === "") {
                throw new ManageError("Root name server records are managed by Linode and can't be changed.", 422);
            }

            return true;
        } catch (error) {
            if (error instanceof ManageError && error.status === 404) return false;
            throw error;
        }
    }

    async addRecord(domainId: string, input: RecordInput) {
        const raw = await this.req<LinodeRecordRaw>(
            "POST",
            `/domains/${encodeURIComponent(domainId)}/records`,
            this.body(input, true),
        );
        return fromLinodeRecord(raw);
    }

   async updateRecord(domainId: string, recordId: string, input: RecordInput) {
        if (!(await this.guard(domainId, recordId))) {
            throw new ManageError("Record not found.", 404);
        }

        const raw = await this.req<LinodeRecordRaw>(
            "PUT",
            `/domains/${encodeURIComponent(domainId)}/records/${encodeURIComponent(recordId)}`,
            this.body(input, false),
        );
        return fromLinodeRecord(raw);
    }

    async removeRecord(domainId: string, recordId: string) {
        if (!(await this.guard(domainId, recordId))) return;

        try {
            await this.req(
                "DELETE",
                `/domains/${encodeURIComponent(domainId)}/records/${encodeURIComponent(recordId)}`,
            );
        } catch (error) {
            if (error instanceof ManageError && error.status === 404) return;
            throw error;
        }
    }

    async updateDomain(id: string, settings: DomainSettings) {
        const raw = await this.req<LinodeDomainRaw>("PUT", `/domains/${encodeURIComponent(id)}`, {
            soa_email: settings.email,
            ttl_sec: settings.ttl,
        });
        return fromLinodeDomain(raw);
    }

    async invoiceItems(invoiceId: string): Promise<InvoiceItem[]> {
        const rows = await this.all<{
            label: string;
            from: string | null;
            to: string | null;
            amount: number;
            tax: number;
            total: number;
        }>(`/account/invoices/${encodeURIComponent(invoiceId)}/items`);

        return rows.map((r) => ({
            label: r.label,
            from: r.from ? String(r.from).slice(0, 10) : "",
            to: r.to ? String(r.to).slice(0, 10) : "",
            amount: Number(r.amount),
            tax: Number(r.tax),
            total: Number(r.total),
        }));
    }

        async billing(): Promise<BillingSummary> {
        const newestFirst = { "X-Filter": JSON.stringify({ "+order_by": "date", "+order": "desc" }) };

        // Linode only accepts page_size 25-500 on these list endpoints, so ask for 25 and trim.
        const [account, invoices, payments, transfer] = await Promise.all([
            this.req<{ balance: number; balance_uninvoiced: number }>("GET", "/account"),
            this.req<{ data: { id: number; label: string; date: string; total: number }[] }>(
                "GET",
                "/account/invoices?page_size=25",
                undefined,
                newestFirst,
            ),
            this.req<{ data: { id: number; date: string; usd: number }[] }>(
                "GET",
                "/account/payments?page_size=25",
                undefined,
                newestFirst,
            ),
            this.req<{ used: number; quota: number }>("GET", "/account/transfer"),
        ]);

        return {
            currency: "USD",
            estimated: false,
            note: "Balance is what you currently owe (a negative number is credit). The month-to-date figure is Linode's own estimate of the next invoice.",
            balance: Number(account.balance ?? 0),
            current: Number(account.balance_uninvoiced ?? 0),
            currentLabel: "This month so far",
            items: [],
            invoices: (invoices.data ?? []).slice(0, 12).map((i) => ({
                id: String(i.id),
                label: i.label,
                date: String(i.date).slice(0, 10),
                total: Number(i.total),
            })),
            payments: (payments.data ?? []).slice(0, 12).map((p) => ({
                id: String(p.id),
                date: String(p.date).slice(0, 10),
                amount: Number(p.usd),
            })),
            transfer: {
                usedGb: Number(transfer.used ?? 0),
                quotaGb: Number(transfer.quota ?? 0),
            },
        };
    }
}

// ---------------------------------------------------------------------------
// Hetzner
// ---------------------------------------------------------------------------

const HETZNER_BASE = "https://api.hetzner.cloud/v1";

interface HzZone {
    id: number | string;
    name: string;
    status?: string;
    mode?: string;
    ttl?: number;
    records_count?: number;
}

interface HzRrset {
    name: string;
    type: string;
    ttl: number | null;
    records: { value: string; comment?: string }[];
}

function hetznerMessage(json: unknown, status: number): string {
    const err = (json as { error?: { message?: string } } | null)?.error;
    return err?.message ?? `Hetzner API error (${status})`;
}

function fromHetznerZone(z: HzZone): ManagedDomain {
    return {
        id: String(z.id),
        name: z.name,
        status: z.status ?? "",
        mode: z.mode ?? "primary",
        email: "",
        ttl: z.ttl ?? 0,
        recordCount: typeof z.records_count === "number" ? z.records_count : null,
    };
}

function encodeRef(name: string, type: string, value: string): string {
    return Buffer.from(JSON.stringify([name, type, value]), "utf8").toString("base64url");
}

function decodeRef(id: string): { name: string; type: string; value: string } {
    try {
        const [name, type, value] = JSON.parse(Buffer.from(id, "base64url").toString("utf8"));
        if (typeof name === "string" && typeof type === "string" && typeof value === "string") {
            return { name, type, value };
        }
    } catch {
        // fall through
    }
    throw new ManageError("Record not found.", 404);
}

function fqdn(host: string): string {
    return host.includes(".") && !host.endsWith(".") ? `${host}.` : host;
}

/** The value as Hetzner stores it. */
function toWire(type: string, value: string, priority: number | null): string {
    const v = value.trim();

    if (type === "MX") return `${priority ?? 10} ${fqdn(v)}`;
    if (type === "CNAME" || type === "NS") return fqdn(v);
    if (type === "TXT") {
        return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v : `"${v.replace(/"/g, '\\"')}"`;
    }
    return v;
}

function hzRecord(name: string, type: string, raw: string, ttl: number): DnsRecord {
    let value = raw;
    let priority: number | null = null;

    if (type === "MX") {
        const m = /^(\d+)\s+(.+)$/.exec(raw);
        if (m) {
            priority = Number(m[1]);
            value = m[2];
        }
    } else if (type === "TXT" && raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
        value = raw.slice(1, -1).replace(/\\"/g, '"');
    }

        return {
        id: encodeRef(name, type, raw),
        type,
        name,
        value,
        ttl,
        priority,
        weight: null,
        port: null,
        service: "",
        protocol: "",
        tag: "",
        locked: type === "SOA" || (type === "NS" && name === "@"),
    };
}

const enc = encodeURIComponent;
const rrsetPath = (zone: string, name: string, type: string) =>
    `/zones/${enc(zone)}/rrsets/${enc(name)}/${enc(type)}`;

class HetznerManage implements ManageAdapter {
    kind = "hetzner";
    private token: string;

    constructor(token: string) {
        this.token = token;
    }

    private req<T>(method: string, path: string, body?: unknown) {
        return call<T>({
            label: "Hetzner",
            base: HETZNER_BASE,
            token: this.token,
            method,
            path,
            body,
            readError: hetznerMessage,
        });
    }

    private async all<T>(path: string, key: string): Promise<T[]> {
        const out: T[] = [];
        const sep = path.includes("?") ? "&" : "?";
        let page: number | null = 1;

        for (let n = 0; page && n < MAX_PAGES; n++) {
            const res: Record<string, unknown> = await this.req(
                "GET",
                `${path}${sep}per_page=50&page=${page}`,
            );
            out.push(...((res[key] as T[]) ?? []));
            page =
                (res.meta as { pagination?: { next_page: number | null } } | undefined)?.pagination
                    ?.next_page ?? null;
        }

        return out;
    }

    private async getRrset(zone: string, name: string, type: string): Promise<HzRrset | null> {
        try {
            return (await this.req<{ rrset: HzRrset }>("GET", rrsetPath(zone, name, type))).rrset;
        } catch (error) {
            if (error instanceof ManageError && error.status === 404) return null;
            throw error;
        }
    }

    isAuthError = isAuth;

    async domains() {
        const rows = await this.all<HzZone>("/zones", "zones");
        return rows.map(fromHetznerZone).sort((a, b) => a.name.localeCompare(b.name));
    }

    async getDomain(id: string) {
        const res = await this.req<{ zone: HzZone }>("GET", `/zones/${enc(id)}`);
        return fromHetznerZone(res.zone);
    }

    async createDomain(name: string) {
        const res = await this.req<{ zone: HzZone }>("POST", "/zones", {
            name,
            mode: "primary",
            ttl: 3600,
        });
        return fromHetznerZone(res.zone);
    }

    async updateDomain(): Promise<ManagedDomain> {
        throw new ManageError("Hetzner zone settings can't be changed here yet.", 422);
    }

    async removeDomain(id: string) {
        try {
            await this.req("DELETE", `/zones/${enc(id)}`);
        } catch (error) {
            if (error instanceof ManageError && error.status === 404) return;
            throw error;
        }
    }

    async records(domainId: string) {
        const rrsets = await this.all<HzRrset>(`/zones/${enc(domainId)}/rrsets`, "rrsets");
        const out: DnsRecord[] = [];

        for (const rr of rrsets) {
            if (rr.type === "SOA") continue;
            for (const rec of rr.records ?? []) {
                out.push(hzRecord(rr.name, rr.type, rec.value, rr.ttl ?? 0));
            }
        }

        return out;
    }

    

    async addRecord(domainId: string, input: RecordInput) {

        if (input.type === "SRV" || input.type === "CAA") {
            throw new ManageError("SRV and CAA records aren't supported for Hetzner yet.", 422);
        }
        const wire = toWire(input.type, input.value, input.priority);
        const path = rrsetPath(domainId, input.name, input.type);
        const existing = await this.getRrset(domainId, input.name, input.type);

        if (!existing) {
            await this.req("POST", `/zones/${enc(domainId)}/rrsets`, {
                name: input.name,
                type: input.type,
                ttl: input.ttl > 0 ? input.ttl : undefined,
                records: [{ value: wire }],
            });
            return hzRecord(input.name, input.type, wire, input.ttl);
        }

        if (existing.records.some((r) => r.value === wire)) {
            throw new ManageError("That record already exists.", 422);
        }

        // The TTL can't ride along on add_records when the set already has one.
        await this.req("POST", `${path}/actions/add_records`, { records: [{ value: wire }] });

        let ttl = existing.ttl ?? 0;
        if (input.ttl > 0 && input.ttl !== ttl) {
            await this.req("POST", `${path}/actions/change_ttl`, { ttl: input.ttl });
            ttl = input.ttl;
        }

        return hzRecord(input.name, input.type, wire, ttl);
    }

    async updateRecord(domainId: string, recordId: string, input: RecordInput) {
        const ref = decodeRef(recordId);

                if (input.type === "SRV" || input.type === "CAA") {
            throw new ManageError("SRV and CAA records aren't supported for Hetzner yet.", 422);
        }

        // Renaming is a move: add under the new name first, then remove the old one.
        if (input.name !== ref.name) {
            const created = await this.addRecord(domainId, { ...input, type: ref.type });
            await this.removeRecord(domainId, recordId);
            return created;
        }

        const wire = toWire(ref.type, input.value, input.priority);
        const path = rrsetPath(domainId, ref.name, ref.type);
        const rr = await this.getRrset(domainId, ref.name, ref.type);

        if (!rr || !rr.records.some((r) => r.value === ref.value)) {
            throw new ManageError("Record not found.", 404);
        }

        if (wire !== ref.value) {
            const next = rr.records.map((r) =>
                r.value === ref.value ? { value: wire } : { value: r.value, comment: r.comment },
            );
            await this.req("POST", `${path}/actions/set_records`, { records: next });
        }

        let ttl = rr.ttl ?? 0;
        if (input.ttl > 0 && input.ttl !== ttl) {
            await this.req("POST", `${path}/actions/change_ttl`, { ttl: input.ttl });
            ttl = input.ttl;
        }

        return hzRecord(ref.name, ref.type, wire, ttl);
    }

    async removeRecord(domainId: string, recordId: string) {
        const ref = decodeRef(recordId);
        const path = rrsetPath(domainId, ref.name, ref.type);
        const rr = await this.getRrset(domainId, ref.name, ref.type);

        if (!rr || !rr.records.some((r) => r.value === ref.value)) return;

        if (rr.records.length <= 1) {
            await this.req("DELETE", path);
        } else {
            await this.req("POST", `${path}/actions/remove_records`, { records: [{ value: ref.value }] });
        }
    }

    async billing(): Promise<BillingSummary> {
        const [servers, types] = await Promise.all([
            this.all<{
                name: string;
                server_type?: { name: string };
                datacenter?: { location?: { name: string } };
            }>("/servers", "servers"),
            this.all<{
                name: string;
                prices: { location: string; price_monthly: { gross: string } }[];
            }>("/server_types", "server_types"),
        ]);

        const priceOf = (type: string, location: string) => {
            const t = types.find((x) => x.name === type);
            const p = t?.prices.find((x) => x.location === location) ?? t?.prices[0];
            return p ? Number(p.price_monthly.gross) : 0;
        };

        const items = servers.map((s) => ({
            label: `${s.name} (${s.server_type?.name ?? "unknown"})`,
            amount: priceOf(s.server_type?.name ?? "", s.datacenter?.location?.name ?? ""),
        }));

        return {
            currency: "EUR",
            estimated: true,
            note: "Hetzner doesn't expose invoices or balance through its API. This is an estimate from the servers in this project (gross, incl. VAT). It leaves out volumes, extra IPs, snapshots, backups and traffic overage. Check the Hetzner console for the real bill.",
            balance: null,
            current: items.reduce((sum, i) => sum + i.amount, 0),
            currentLabel: "Estimated per month",
            items,
            invoices: [],
            payments: [],
            transfer: null,
        };
    }
}

// ---------------------------------------------------------------------------

/** Builds the adapter for a stored provider kind. `secret` is the decrypted token. */
export function manageFor(kind: string, secret: string): ManageAdapter {
    switch (kind) {
        case "linode":
            return new LinodeManage(secret);
        case "hetzner":
            return new HetznerManage(secret);
        default:
            throw new Error(`Domains and billing aren't supported for ${kind} yet.`);
    }
}