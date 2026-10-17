/**
 * Service: ProviderResources
 *
 * Machines, firewalls, volumes, images and IP addresses for the providers
 * that support them (Linode and Hetzner). Kept separate from ProviderManage
 * (DNS + billing) and ProviderAdapter (provisioning).
 *
 * Differences this hides:
 *   - Linode firewalls hold inbound + outbound rule lists with ACCEPT/DROP
 *     rules and a default policy. Hetzner firewalls are allow-only: one flat
 *     rule list with a direction, and anything not allowed is dropped.
 *   - Linode image ids look like "private/123". We expose only "123".
 *   - Hetzner IPs come from two lists (primary + floating). Their ids are
 *     exposed as "primary-12" / "floating-34".
 *   - Hetzner ports are one port or one range per rule. Linode takes
 *     comma lists. The Hetzner adapter rejects commas with a clear message.
 */

import { ManageError } from "./ProviderManage.js";

const TIMEOUT_MS = 20_000;
const PER_PAGE = 100;
const MAX_PAGES = 50;
const enc = encodeURIComponent;

export const RESOURCE_KINDS = ["linode", "hetzner"];

/** Shown when a token is rejected for a resource call. */
export const RESOURCE_ACCESS_HELP: Record<string, string> = {
    linode:
        "This Linode token can't use that. Create a new personal access token with Linodes, Firewalls, Volumes, Images and IPs set to Read/Write (keep Domains: Read/Write and Account: Read Only), then Edit this connection and paste it.",
    hetzner:
        "This Hetzner token can't change that. Create a project API token with Read & Write permission (Security → API tokens), then Edit this connection and paste it.",
};

// ---------------------------------------------------------------------------
// Shapes shared with the pages
// ---------------------------------------------------------------------------

export type MachineAction = "boot" | "shutdown" | "reboot";

export interface MachineSummary {
    id: string;
    label: string;
    /** running | offline | booting | shutting_down | rebooting | provisioning | other */
    status: string;
    ip: string;
    region: string;
    plan: string;
    created: string;
}

export interface FirewallRule {
    direction: "in" | "out";
    /** TCP | UDP | ICMP | ESP | GRE */
    protocol: string;
    /** "" for ICMP. Linode: "22,80,8000-8100". Hetzner: "22" or "8000-8100". */
    ports: string;
    /** IPv4 and IPv6 CIDRs in one list. */
    addresses: string[];
    action: "ACCEPT" | "DROP";
    label: string;
}

export interface FirewallRules {
    inboundPolicy: "ACCEPT" | "DROP";
    outboundPolicy: "ACCEPT" | "DROP";
    rules: FirewallRule[];
}

export interface FirewallSummary extends FirewallRules {
    id: string;
    label: string;
    status: string;
    attached: number;
    /** False on Hetzner: allow-only, the policy follows from the rules. */
    policiesEditable: boolean;
}

export interface VolumeSummary {
    id: string;
    label: string;
    sizeGb: number;
    region: string;
    status: string;
    attachedId: string | null;
    attachedName: string;
    device: string;
}

export interface VolumeInput {
    label: string;
    sizeGb: number;
    region: string;
    machineId: string;
}

export interface ImageSummary {
    id: string;
    label: string;
    description: string;
    sizeMb: number;
    status: string;
    /** manual | automatic | snapshot | backup */
    source: string;
    created: string;
}

export interface IpSummary {
    id: string;
    address: string;
    version: "v4" | "v6";
    /** public | private | primary | floating */
    kind: string;
    attachedId: string | null;
    attachedName: string;
    region: string;
    rdns: string;
    label: string;
}

export interface IpAllocateInput {
    version: "v4" | "v6";
    region: string;
    machineId: string;
    label: string;
}

export interface ResourceAdapter {
    kind: string;
    isAuthError(error: unknown): boolean;

    machines(): Promise<MachineSummary[]>;
    machineAction(id: string, action: MachineAction): Promise<void>;

    firewalls(): Promise<FirewallSummary[]>;
    createFirewall(label: string): Promise<FirewallSummary>;
    setFirewallRules(id: string, set: FirewallRules): Promise<FirewallSummary>;
    removeFirewall(id: string): Promise<void>;

    volumes(): Promise<VolumeSummary[]>;
    createVolume(input: VolumeInput): Promise<VolumeSummary>;
    attachVolume(id: string, machineId: string): Promise<void>;
    detachVolume(id: string): Promise<void>;
    removeVolume(id: string): Promise<void>;

    images(): Promise<ImageSummary[]>;
    createImage(machineId: string, label: string): Promise<ImageSummary>;
    renameImage(id: string, label: string): Promise<void>;
    removeImage(id: string): Promise<void>;

    ips(): Promise<IpSummary[]>;
    allocateIp(input: IpAllocateInput): Promise<IpSummary>;
    setRdns(id: string, rdns: string): Promise<void>;
    removeIp(id: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared HTTP
// ---------------------------------------------------------------------------

type Http = <T>(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
) => Promise<T>;

function describeNetworkFailure(error: unknown): string {
    const err = error as { name?: string; code?: string; cause?: { code?: string } } | null;

    if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timed out";

    const code = err?.cause?.code ?? err?.code;
    return code ? String(code) : "network error";
}

function makeHttp(
    label: string,
    base: string,
    token: string,
    readError: (json: unknown, status: number) => string,
): Http {
    async function http<T>(
        method: string,
        path: string,
        body?: unknown,
        headers?: Record<string, string>,
    ): Promise<T> {
        const all: Record<string, string> = {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(headers ?? {}),
        };
        if (body !== undefined) all["Content-Type"] = "application/json";

        let response: Response;
        try {
            response = await fetch(`${base}${path}`, {
                method,
                headers: all,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (error) {
            // Never include the request details here: they carry the token.
            throw new ManageError(`Could not reach the ${label} API (${describeNetworkFailure(error)}).`, 0);
        }

        const text = await response.text();
        let json: unknown = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            // Empty or non-JSON body (204s): json stays null.
        }

        if (!response.ok) {
            throw new ManageError(readError(json, response.status), response.status);
        }

        return json as T;
    }

    return http;
}

const isAuth = (error: unknown) =>
    error instanceof ManageError && (error.status === 401 || error.status === 403);

const isMissing = (error: unknown) => error instanceof ManageError && error.status === 404;

async function linodeAll<T>(http: Http, path: string, headers?: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";

    for (let page = 1; page <= MAX_PAGES; page++) {
        const res = await http<{ data: T[]; pages: number }>(
            "GET",
            `${path}${sep}page=${page}&page_size=${PER_PAGE}`,
            undefined,
            headers,
        );
        out.push(...(res.data ?? []));
        if (page >= (res.pages ?? 1)) break;
    }

    return out;
}

async function hetznerAll<T>(http: Http, path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    let page: number | null = 1;

    for (let n = 0; page && n < MAX_PAGES; n++) {
        const res: Record<string, unknown> = await http("GET", `${path}${sep}per_page=50&page=${page}`);
        out.push(...((res[key] as T[]) ?? []));
        page =
            (res.meta as { pagination?: { next_page: number | null } } | undefined)?.pagination?.next_page ?? null;
    }

    return out;
}

// ---------------------------------------------------------------------------
// Linode
// ---------------------------------------------------------------------------

const LINODE_BASE = "https://api.linode.com/v4";

function linodeMessage(json: unknown, status: number): string {
    const errors = (json as { errors?: { field?: string; reason: string }[] } | null)?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
        return errors.map((e) => (e.field ? `${e.field}: ${e.reason}` : e.reason)).join(" ");
    }
    return `Linode API error (${status})`;
}

interface LinodeInstanceRaw {
    id: number;
    label: string;
    status: string;
    ipv4: string[];
    region: string;
    type: string;
    created: string;
}

interface LinodeRuleRaw {
    action: string;
    protocol: string;
    ports?: string;
    addresses?: { ipv4?: string[]; ipv6?: string[] };
    label?: string;
    description?: string;
}

interface LinodeFirewallRaw {
    id: number;
    label: string;
    status: string;
    rules: {
        inbound?: LinodeRuleRaw[];
        inbound_policy: string;
        outbound?: LinodeRuleRaw[];
        outbound_policy: string;
    };
}

interface LinodeVolumeRaw {
    id: number;
    label: string;
    size: number;
    region: string;
    status: string;
    linode_id: number | null;
    linode_label: string | null;
    filesystem_path: string;
}

interface LinodeImageRaw {
    id: string;
    label: string;
    description: string | null;
    size: number;
    status: string;
    type: string;
    created: string;
}

interface LinodeIpRaw {
    address: string;
    type: string;
    public: boolean;
    rdns: string | null;
    linode_id: number | null;
    region: string;
}

const policy = (value: string): "ACCEPT" | "DROP" => (value === "ACCEPT" ? "ACCEPT" : "DROP");

function fromLinodeRule(direction: "in" | "out", r: LinodeRuleRaw): FirewallRule {
    return {
        direction,
        protocol: r.protocol,
        ports: r.ports ?? "",
        addresses: [...(r.addresses?.ipv4 ?? []), ...(r.addresses?.ipv6 ?? [])],
        action: r.action === "DROP" ? "DROP" : "ACCEPT",
        label: r.label ?? "",
    };
}

function toLinodeRule(r: FirewallRule): LinodeRuleRaw {
    if (r.protocol !== "TCP" && r.protocol !== "UDP" && r.protocol !== "ICMP") {
        throw new ManageError("Linode firewalls support TCP, UDP and ICMP rules only.", 422);
    }

    const v6 = r.addresses.filter((a) => a.includes(":"));
    const v4 = r.addresses.filter((a) => !a.includes(":"));

    return {
        action: r.action,
        protocol: r.protocol,
        ports: r.protocol === "ICMP" || r.ports === "" ? undefined : r.ports,
        addresses: { ...(v4.length ? { ipv4: v4 } : {}), ...(v6.length ? { ipv6: v6 } : {}) },
        label: r.label || undefined,
    };
}

function fromLinodeFirewall(f: LinodeFirewallRaw, attached: number): FirewallSummary {
    return {
        id: String(f.id),
        label: f.label,
        status: f.status,
        attached,
        policiesEditable: true,
        inboundPolicy: policy(f.rules.inbound_policy),
        outboundPolicy: policy(f.rules.outbound_policy),
        rules: [
            ...(f.rules.inbound ?? []).map((r) => fromLinodeRule("in", r)),
            ...(f.rules.outbound ?? []).map((r) => fromLinodeRule("out", r)),
        ],
    };
}

function fromLinodeVolume(v: LinodeVolumeRaw): VolumeSummary {
    return {
        id: String(v.id),
        label: v.label,
        sizeGb: v.size,
        region: v.region,
        status: v.status,
        attachedId: v.linode_id === null ? null : String(v.linode_id),
        attachedName: v.linode_label ?? "",
        device: v.filesystem_path ?? "",
    };
}

function fromLinodeImage(i: LinodeImageRaw): ImageSummary {
    return {
        id: String(i.id).replace(/^private\//, ""),
        label: i.label,
        description: i.description ?? "",
        sizeMb: Number(i.size ?? 0),
        status: i.status,
        source: i.type ?? "manual",
        created: String(i.created ?? "").slice(0, 10),
    };
}

class LinodeResources implements ResourceAdapter {
    kind = "linode";
    private http: Http;

    constructor(token: string) {
        this.http = makeHttp("Linode", LINODE_BASE, token, linodeMessage);
    }

    private req<T>(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
        return this.http<T>(method, path, body, headers);
    }

    isAuthError = isAuth;

    // ---- Machines ----

    async machines(): Promise<MachineSummary[]> {
        const rows = await linodeAll<LinodeInstanceRaw>(this.http, "/linode/instances");
        return rows.map((m) => ({
            id: String(m.id),
            label: m.label,
            status: m.status === "offline" ? "offline" : m.status,
            ip: m.ipv4?.[0] ?? "",
            region: m.region,
            plan: m.type,
            created: String(m.created ?? "").slice(0, 10),
        }));
    }

    async machineAction(id: string, action: MachineAction) {
        await this.req("POST", `/linode/instances/${enc(id)}/${action}`, {});
    }

    // ---- Firewalls ----

    private async attachedCount(id: string | number): Promise<number> {
        const devices = await linodeAll<{ id: number }>(this.http, `/networking/firewalls/${id}/devices`);
        return devices.length;
    }

    async firewalls() {
        const rows = await linodeAll<LinodeFirewallRaw>(this.http, "/networking/firewalls");
        return Promise.all(rows.map(async (f) => fromLinodeFirewall(f, await this.attachedCount(f.id))));
    }

    private async getFirewall(id: string) {
        const raw = await this.req<LinodeFirewallRaw>("GET", `/networking/firewalls/${enc(id)}`);
        return fromLinodeFirewall(raw, await this.attachedCount(raw.id));
    }

    async createFirewall(label: string) {
        const raw = await this.req<LinodeFirewallRaw>("POST", "/networking/firewalls", {
            label,
            rules: { inbound: [], inbound_policy: "DROP", outbound: [], outbound_policy: "ACCEPT" },
        });
        return fromLinodeFirewall(raw, 0);
    }

    async setFirewallRules(id: string, set: FirewallRules) {
        await this.req("PUT", `/networking/firewalls/${enc(id)}/rules`, {
            inbound: set.rules.filter((r) => r.direction === "in").map(toLinodeRule),
            inbound_policy: set.inboundPolicy,
            outbound: set.rules.filter((r) => r.direction === "out").map(toLinodeRule),
            outbound_policy: set.outboundPolicy,
        });
        return this.getFirewall(id);
    }

    async removeFirewall(id: string) {
        try {
            await this.req("DELETE", `/networking/firewalls/${enc(id)}`);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
    }

    // ---- Volumes ----

    async volumes() {
        const rows = await linodeAll<LinodeVolumeRaw>(this.http, "/volumes");
        return rows.map(fromLinodeVolume);
    }

    async createVolume(input: VolumeInput) {
        // A volume created for a Linode takes that Linode's region, so region is only sent alone.
        const body: Record<string, unknown> = { label: input.label, size: input.sizeGb };
        if (input.machineId) body.linode_id = Number(input.machineId);
        else body.region = input.region;

        return fromLinodeVolume(await this.req<LinodeVolumeRaw>("POST", "/volumes", body));
    }

    async attachVolume(id: string, machineId: string) {
        await this.req("POST", `/volumes/${enc(id)}/attach`, { linode_id: Number(machineId) });
    }

    async detachVolume(id: string) {
        await this.req("POST", `/volumes/${enc(id)}/detach`, {});
    }

    async removeVolume(id: string) {
        try {
            await this.req("DELETE", `/volumes/${enc(id)}`);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
    }

    // ---- Images ----

    async images() {
        const rows = await linodeAll<LinodeImageRaw>(this.http, "/images", {
            "X-Filter": JSON.stringify({ is_public: false }),
        });
        return rows.map(fromLinodeImage);
    }

    async createImage(machineId: string, label: string) {
        const disks = await linodeAll<{ id: number; size: number; filesystem: string }>(
            this.http,
            `/linode/instances/${enc(machineId)}/disks`,
        );
        const disk = disks.filter((d) => d.filesystem !== "swap").sort((a, b) => b.size - a.size)[0];

        if (!disk) {
            throw new ManageError("That Linode has no disk that can be captured as an image.", 422);
        }

        const raw = await this.req<LinodeImageRaw>("POST", "/images", { disk_id: disk.id, label });
        return fromLinodeImage(raw);
    }

    async renameImage(id: string, label: string) {
        await this.req("PUT", `/images/private/${enc(id)}`, { label });
    }

    async removeImage(id: string) {
        try {
            await this.req("DELETE", `/images/private/${enc(id)}`);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
    }

    // ---- IPs ----

    async ips() {
        const [rows, machines] = await Promise.all([
            linodeAll<LinodeIpRaw>(this.http, "/networking/ips"),
            this.machines(),
        ]);
        const names = new Map(machines.map((m) => [m.id, m.label]));

        return rows.map((ip): IpSummary => {
            const attachedId = ip.linode_id === null ? null : String(ip.linode_id);
            return {
                id: ip.address,
                address: ip.address,
                version: ip.type === "ipv6" ? "v6" : "v4",
                kind: ip.public ? "public" : "private",
                attachedId,
                attachedName: attachedId ? (names.get(attachedId) ?? "") : "",
                region: ip.region,
                rdns: ip.rdns ?? "",
                label: "",
            };
        });
    }

    async allocateIp(input: IpAllocateInput) {
        if (input.version === "v6") {
            throw new ManageError("Linode doesn't allocate single IPv6 addresses here. Use an IPv4 address.", 422);
        }
        if (!input.machineId) {
            throw new ManageError("Choose the Linode this address is for.", 422);
        }

        const raw = await this.req<LinodeIpRaw>("POST", "/networking/ips", {
            type: "ipv4",
            public: true,
            linode_id: Number(input.machineId),
        });

        return {
            id: raw.address,
            address: raw.address,
            version: "v4" as const,
            kind: "public",
            attachedId: raw.linode_id === null ? null : String(raw.linode_id),
            attachedName: "",
            region: raw.region,
            rdns: raw.rdns ?? "",
            label: "",
        };
    }

    async setRdns(id: string, rdns: string) {
        await this.req("PUT", `/networking/ips/${enc(id)}`, { rdns: rdns === "" ? null : rdns });
    }

    async removeIp(id: string) {
        const ip = await this.req<LinodeIpRaw>("GET", `/networking/ips/${enc(id)}`);

        if (ip.linode_id === null) {
            throw new ManageError("That address isn't assigned to a Linode.", 422);
        }

        await this.req("DELETE", `/linode/instances/${ip.linode_id}/ips/${enc(id)}`);
    }
}

// ---------------------------------------------------------------------------
// Hetzner
// ---------------------------------------------------------------------------

const HETZNER_BASE = "https://api.hetzner.cloud/v1";

function hetznerMessage(json: unknown, status: number): string {
    const err = (json as { error?: { message?: string } } | null)?.error;
    return err?.message ?? `Hetzner API error (${status})`;
}

interface HzServerRaw {
    id: number;
    name: string;
    status: string;
    created: string;
    public_net?: { ipv4?: { ip: string } | null };
    server_type?: { name: string };
    datacenter?: { location?: { name: string } };
}

interface HzRuleRaw {
    direction: string;
    protocol: string;
    port?: string | null;
    source_ips?: string[];
    destination_ips?: string[];
    description?: string | null;
}

interface HzFirewallRaw {
    id: number;
    name: string;
    rules: HzRuleRaw[];
    applied_to?: unknown[];
}

interface HzVolumeRaw {
    id: number;
    name: string;
    size: number;
    status: string;
    server: number | null;
    linux_device?: string;
    location?: { name: string };
}

interface HzImageRaw {
    id: number;
    description: string | null;
    type: string;
    status: string;
    image_size: number | null;
    disk_size: number;
    created: string;
}

interface HzDnsPtr {
    ip: string;
    dns_ptr: string;
}

interface HzIpRaw {
    id: number;
    name?: string;
    type: string;
    ip: string;
    dns_ptr?: HzDnsPtr[];
    server?: number | null;
    assignee_id?: number | null;
    datacenter?: { location?: { name: string } };
    home_location?: { name: string };
}

function fromHetznerRule(r: HzRuleRaw): FirewallRule {
    const direction = r.direction === "out" ? "out" : "in";
    return {
        direction,
        protocol: r.protocol.toUpperCase(),
        ports: r.port ?? "",
        addresses: (direction === "in" ? r.source_ips : r.destination_ips) ?? [],
        action: "ACCEPT",
        label: r.description ?? "",
    };
}

function toHetznerRule(r: FirewallRule): HzRuleRaw {
    if (r.action === "DROP") {
        throw new ManageError(
            "Hetzner firewalls only allow traffic. Anything you don't allow is blocked, so remove the blocking rule.",
            422,
        );
    }
    if (r.ports.includes(",")) {
        throw new ManageError(
            "Hetzner takes one port or one range per rule (like 80 or 8000-8100). Add a rule for each port.",
            422,
        );
    }

    const rule: HzRuleRaw = {
        direction: r.direction,
        protocol: r.protocol.toLowerCase(),
        description: r.label || undefined,
    };

    if (r.protocol === "TCP" || r.protocol === "UDP") rule.port = r.ports;
    if (r.direction === "in") rule.source_ips = r.addresses;
    else rule.destination_ips = r.addresses;

    return rule;
}

function fromHetznerFirewall(f: HzFirewallRaw): FirewallSummary {
    const rules = (f.rules ?? []).map(fromHetznerRule);
    const attached = (f.applied_to ?? []).length;

    return {
        id: String(f.id),
        label: f.name,
        status: attached > 0 ? "attached" : "unattached",
        attached,
        policiesEditable: false,
        inboundPolicy: "DROP",
        outboundPolicy: rules.some((r) => r.direction === "out") ? "DROP" : "ACCEPT",
        rules,
    };
}

function fromHetznerVolume(v: HzVolumeRaw, names: Map<string, string>): VolumeSummary {
    const attachedId = v.server === null || v.server === undefined ? null : String(v.server);
    return {
        id: String(v.id),
        label: v.name,
        sizeGb: v.size,
        region: v.location?.name ?? "",
        status: v.status,
        attachedId,
        attachedName: attachedId ? (names.get(attachedId) ?? "") : "",
        device: v.linux_device ?? "",
    };
}

function fromHetznerImage(i: HzImageRaw): ImageSummary {
    const gb = i.image_size ?? i.disk_size ?? 0;
    return {
        id: String(i.id),
        label: i.description ?? `Image ${i.id}`,
        description: "",
        sizeMb: Math.round(Number(gb) * 1024),
        status: i.status,
        source: i.type,
        created: String(i.created ?? "").slice(0, 10),
    };
}

function fromHetznerIp(raw: HzIpRaw, kind: "primary" | "floating", names: Map<string, string>): IpSummary {
    const serverId = kind === "primary" ? raw.assignee_id : raw.server;
    const attachedId = serverId === null || serverId === undefined ? null : String(serverId);

    return {
        id: `${kind}-${raw.id}`,
        address: raw.ip,
        version: raw.type === "ipv6" ? "v6" : "v4",
        kind,
        attachedId,
        attachedName: attachedId ? (names.get(attachedId) ?? "") : "",
        region: raw.home_location?.name ?? raw.datacenter?.location?.name ?? "",
        rdns: raw.dns_ptr?.[0]?.dns_ptr ?? "",
        label: raw.name ?? "",
    };
}

function parseHetznerIp(id: string): { kind: "primary" | "floating"; raw: string } {
    const m = /^(primary|floating)-(\d+)$/.exec(id);
    if (!m) throw new ManageError("IP address not found.", 404);
    return { kind: m[1] as "primary" | "floating", raw: m[2] };
}

class HetznerResources implements ResourceAdapter {
    kind = "hetzner";
    private http: Http;

    constructor(token: string) {
        this.http = makeHttp("Hetzner", HETZNER_BASE, token, hetznerMessage);
    }

    private req<T>(method: string, path: string, body?: unknown) {
        return this.http<T>(method, path, body);
    }

    isAuthError = isAuth;

    // ---- Machines ----

    async machines(): Promise<MachineSummary[]> {
        const rows = await hetznerAll<HzServerRaw>(this.http, "/servers", "servers");
        return rows.map((s) => ({
            id: String(s.id),
            label: s.name,
            status: s.status === "off" ? "offline" : s.status,
            ip: s.public_net?.ipv4?.ip ?? "",
            region: s.datacenter?.location?.name ?? "",
            plan: s.server_type?.name ?? "",
            created: String(s.created ?? "").slice(0, 10),
        }));
    }

    private async machineNames(): Promise<Map<string, string>> {
        return new Map((await this.machines()).map((m) => [m.id, m.label]));
    }

    async machineAction(id: string, action: MachineAction) {
        const wire = action === "boot" ? "poweron" : action;
        await this.req("POST", `/servers/${enc(id)}/actions/${wire}`, {});
    }

    // ---- Firewalls ----

    async firewalls() {
        const rows = await hetznerAll<HzFirewallRaw>(this.http, "/firewalls", "firewalls");
        return rows.map(fromHetznerFirewall);
    }

    private async getFirewall(id: string) {
        const res = await this.req<{ firewall: HzFirewallRaw }>("GET", `/firewalls/${enc(id)}`);
        return fromHetznerFirewall(res.firewall);
    }

    async createFirewall(label: string) {
        const res = await this.req<{ firewall: HzFirewallRaw }>("POST", "/firewalls", { name: label });
        return fromHetznerFirewall(res.firewall);
    }

    async setFirewallRules(id: string, set: FirewallRules) {
        // The policies are ignored: Hetzner derives them from the rules.
        await this.req("POST", `/firewalls/${enc(id)}/actions/set_rules`, {
            rules: set.rules.map(toHetznerRule),
        });
        return this.getFirewall(id);
    }

    async removeFirewall(id: string) {
        try {
            await this.req("DELETE", `/firewalls/${enc(id)}`);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
    }

    // ---- Volumes ----

    async volumes() {
        const [rows, names] = await Promise.all([
            hetznerAll<HzVolumeRaw>(this.http, "/volumes", "volumes"),
            this.machineNames(),
        ]);
        return rows.map((v) => fromHetznerVolume(v, names));
    }

    async createVolume(input: VolumeInput) {
        // Hetzner wants a location or a server, never both.
        const body: Record<string, unknown> = {
            name: input.label,
            size: input.sizeGb,
            format: "ext4",
            automount: false,
        };
        if (input.machineId) body.server = Number(input.machineId);
        else body.location = input.region;

        const res = await this.req<{ volume: HzVolumeRaw }>("POST", "/volumes", body);
        return fromHetznerVolume(res.volume, new Map());
    }

    async attachVolume(id: string, machineId: string) {
        await this.req("POST", `/volumes/${enc(id)}/actions/attach`, {
            server: Number(machineId),
            automount: false,
        });
    }

    async detachVolume(id: string) {
        await this.req("POST", `/volumes/${enc(id)}/actions/detach`, {});
    }

    async removeVolume(id: string) {
        try {
            await this.req("DELETE", `/volumes/${enc(id)}`);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
    }

    // ---- Images ----

    async images() {
        // Only the project's own images: snapshots and backups. System images are not listed.
        const [snapshots, backups] = await Promise.all([
            hetznerAll<HzImageRaw>(this.http, "/images?type=snapshot", "images"),
            hetznerAll<HzImageRaw>(this.http, "/images?type=backup", "images"),
        ]);
        return [...snapshots, ...backups].map(fromHetznerImage);
    }

    async createImage(machineId: string, label: string) {
        const res = await this.req<{ image: HzImageRaw }>("POST", `/servers/${enc(machineId)}/actions/create_image`, {
            type: "snapshot",
            description: label,
        });
        return fromHetznerImage(res.image);
    }

    async renameImage(id: string, label: string) {
        await this.req("PUT", `/images/${enc(id)}`, { description: label });
    }

    async removeImage(id: string) {
        try {
            await this.req("DELETE", `/images/${enc(id)}`);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
    }

    // ---- IPs ----

    async ips() {
        const [primary, floating, names] = await Promise.all([
            hetznerAll<HzIpRaw>(this.http, "/primary_ips", "primary_ips"),
            hetznerAll<HzIpRaw>(this.http, "/floating_ips", "floating_ips"),
            this.machineNames(),
        ]);

        return [
            ...primary.map((p) => fromHetznerIp(p, "primary", names)),
            ...floating.map((f) => fromHetznerIp(f, "floating", names)),
        ];
    }

    async allocateIp(input: IpAllocateInput) {
        // Primary IPs are created together with a server. Only floating IPs are allocated here.
        const body: Record<string, unknown> = {
            type: input.version === "v6" ? "ipv6" : "ipv4",
            name: input.label || undefined,
        };
        if (input.machineId) body.server = Number(input.machineId);
        else body.home_location = input.region;

        const res = await this.req<{ floating_ip: HzIpRaw }>("POST", "/floating_ips", body);
        return fromHetznerIp(res.floating_ip, "floating", new Map());
    }

    async setRdns(id: string, rdns: string) {
        const { kind, raw } = parseHetznerIp(id);
        const list = kind === "primary" ? "primary_ips" : "floating_ips";
        const key = kind === "primary" ? "primary_ip" : "floating_ip";

        const res = await this.req<Record<string, HzIpRaw>>("GET", `/${list}/${raw}`);
        const cur = res[key];

        // IPv6 is a /64: the PTR belongs to one address inside it.
        const ip = cur.dns_ptr?.[0]?.ip ?? (cur.type === "ipv6" ? `${cur.ip.replace(/\/\d+$/, "")}1` : cur.ip);

        await this.req("POST", `/${list}/${raw}/actions/change_dns_ptr`, {
            ip,
            dns_ptr: rdns === "" ? null : rdns,
        });
    }

    async removeIp(id: string) {
        const { kind, raw } = parseHetznerIp(id);
        try {
            await this.req("DELETE", `/${kind === "primary" ? "primary_ips" : "floating_ips"}/${raw}`);
        } catch (error) {
            if (isMissing(error)) return;
            throw error;
        }
    }
}

// ---------------------------------------------------------------------------

/** Builds the adapter for a stored provider kind. `secret` is the decrypted token. */
export function resourcesFor(kind: string, secret: string): ResourceAdapter {
    switch (kind) {
        case "linode":
            return new LinodeResources(secret);
        case "hetzner":
            return new HetznerResources(secret);
        default:
            throw new Error(`Provider resources aren't supported for ${kind} yet.`);
    }
}