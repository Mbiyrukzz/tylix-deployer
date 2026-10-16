/**
 * Minimal Vultr API v2 client. No third-party dependencies (Node's fetch).
 *
 * Differences the job must respect:
 *   - Instance ids are UUID strings (hence provisions.instance_ref).
 *   - Every endpoint needs the API key, including the catalog ones.
 *   - A new instance is status "pending" with main_ip "0.0.0.0" until it is built.
 *   - Cloud-init user_data must be base64. We set disable_root: false, because
 *     Ubuntu's default cloud-init strips root's authorized_keys.
 *   - Vultr API keys have an access-control list. A key limited to specific IPs
 *     answers 401/403 from the deployer's server. The user must allow its IP
 *     (or "Allow all IPv4") in Account -> API.
 *   - Prices are USD.
 */

const API_BASE = "https://api.vultr.com/v2";
const TIMEOUT_MS = 20_000;
const PER_PAGE = 500;
const MAX_PAGES = 20;

/** Regular and high-frequency cloud compute only. Bare metal and GPU are skipped. */
const PLAN_PREFIXES = ["vc2-", "vhf-", "vhp-"];

export interface VultrRegion { id: string; label: string; country: string }
export interface VultrPlan {
    id: string; label: string; class: string; memory_mb: number; vcpus: number;
    disk_gb: number; monthly: number; hourly: number; currency: "USD";
}
export interface VultrImage { id: string; label: string }
export interface VultrInstance {
    id: string; label: string; status: string; power_status: string;
    main_ip: string; region: string; tags: string[];
}
export interface CreateVultrInstanceInput {
    region: string; type: string; image: string; label: string; hostname: string;
    authorizedKeys: string[]; tags?: string[];
}

export class VultrError extends Error {
    status: number;
    constructor(message: string, status: number) {
        super(message);
        this.name = "VultrError";
        this.status = status;
    }
}

function describeNetworkFailure(error: unknown): string {
    const err = error as { name?: string; code?: string; cause?: { code?: string } } | null;
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timed out";
    const code = err?.cause?.code ?? err?.code;
    return code ? String(code) : "network error";
}

function buildUserData(keys: string[]): string {
    const lines = ["#cloud-config", "disable_root: false", "ssh_pwauth: false", "ssh_authorized_keys:"];
    for (const key of keys) lines.push(`  - ${JSON.stringify(key.trim())}`);
    return Buffer.from(lines.join("\n") + "\n", "utf8").toString("base64");
}

async function request<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
        response = await fetch(`${API_BASE}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (error) {
        // Never include request details: they carry the token.
        throw new VultrError(`Could not reach the Vultr API (${describeNetworkFailure(error)}).`, 0);
    }

    const text = await response.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* empty 204 or non-JSON */ }

    if (!response.ok) {
        const err = json as { error?: string } | null;
        throw new VultrError(err?.error ?? `Vultr API error (${response.status})`, response.status);
    }
    return json as T;
}

interface RawInstance {
    id: string; label: string; status: string; power_status: string;
    main_ip: string; region: string; tags?: string[];
}

const toInstance = (r: RawInstance): VultrInstance => ({
    id: r.id, label: r.label, status: r.status, power_status: r.power_status,
    main_ip: r.main_ip, region: r.region, tags: r.tags ?? [],
});

export class VultrClient {
    private token: string;
    constructor(token: string) { this.token = token; }

    /** 401/403 means a bad key, or the IP access list. Read-only keys pass and fail on create. */
    async verify(): Promise<void> {
        await request("GET", "/instances?per_page=1", this.token);
    }

    /** Follows meta.links.next (a cursor) until every page of `key` is collected. */
    private async all<T>(path: string, key: string): Promise<T[]> {
        const out: T[] = [];
        const sep = path.includes("?") ? "&" : "?";
        let cursor = "";

        for (let page = 0; page < MAX_PAGES; page++) {
            const url = `${path}${sep}per_page=${PER_PAGE}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
            const res = await request<Record<string, unknown>>("GET", url, this.token);
            out.push(...((res[key] as T[]) ?? []));

            const next = (res.meta as { links?: { next?: string } } | undefined)?.links?.next;
            if (!next) break;
            cursor = next;
        }
        return out;
    }

    async createInstance(input: CreateVultrInstanceInput): Promise<VultrInstance> {
        const res = await request<{ instance: RawInstance }>("POST", "/instances", this.token, {
            region: input.region,
            plan: input.type,
            os_id: Number(input.image),
            label: input.label,
            hostname: input.hostname,
            tags: input.tags ?? [],
            user_data: buildUserData(input.authorizedKeys),
            backups: "disabled",
            enable_ipv6: false,
        });
        return toInstance(res.instance);
    }

    async getInstance(id: string): Promise<VultrInstance> {
        const res = await request<{ instance: RawInstance }>("GET", `/instances/${encodeURIComponent(id)}`, this.token);
        return toInstance(res.instance);
    }

    async findByTag(tag: string): Promise<VultrInstance | null> {
        const res = await request<{ instances: RawInstance[] }>(
            "GET", `/instances?tag=${encodeURIComponent(tag)}&per_page=1`, this.token,
        );
        return res.instances.length > 0 ? toInstance(res.instances[0]) : null;
    }

    async deleteInstance(id: string): Promise<void> {
        try {
            await request("DELETE", `/instances/${encodeURIComponent(id)}`, this.token);
        } catch (error) {
            if (error instanceof VultrError && error.status === 404) return;
            throw error;
        }
    }

    // ---- Catalog (needs the key on Vultr) ----

    async regions(): Promise<VultrRegion[]> {
        const rows = await this.all<{ id: string; city: string; country: string }>("/regions", "regions");
        return rows
            .map((r) => ({ id: r.id, label: `${r.city} (${r.country})`, country: r.country }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    async plans(region?: string): Promise<VultrPlan[]> {
        const rows = await this.all<{
            id: string; vcpu_count: number; ram: number; disk: number;
            monthly_cost: number; type: string; locations: string[];
        }>("/plans", "plans");

        const plans: VultrPlan[] = [];
        for (const p of rows) {
            if (!PLAN_PREFIXES.some((prefix) => p.id.startsWith(prefix))) continue;
            if (region && !p.locations.includes(region)) continue;

            const monthly = Number(p.monthly_cost);
            plans.push({
                id: p.id,
                label: p.id,
                class: p.type,
                memory_mb: p.ram,
                vcpus: p.vcpu_count,
                disk_gb: p.disk,
                monthly,
                hourly: Math.round((monthly / 730) * 10000) / 10000,
                currency: "USD",
            });
        }
        return plans.sort((a, b) => a.monthly - b.monthly);
    }

    /** Ubuntu 24.04 / 22.04 x64 only, since Installers.ts rejects everything else. */
    async images(): Promise<VultrImage[]> {
        const rows = await this.all<{ id: number; name: string; arch: string; family: string }>("/os", "os");
        return rows
            .filter((o) => o.family === "ubuntu" && o.arch === "x64" && /^Ubuntu 2[24]\.04/.test(o.name))
            .map((o) => ({ id: String(o.id), label: o.name.replace(/\s*x64$/, "") }))
            .sort((a, b) => b.label.localeCompare(a.label));
    }
}