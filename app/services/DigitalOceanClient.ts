/**
 * Minimal DigitalOcean API v2 client. No third-party dependencies:
 * it uses Node's built-in fetch.
 *
 * Like Hetzner, EVERY endpoint needs a personal access token, including the
 * catalog ones (regions, sizes, images), so the catalog methods are instance
 * methods.
 *
 * Differences the provision job must respect:
 *   - Droplet ids are numbers (they fit provisions.instance_id).
 *   - A droplet is "new" while it is being built and "active" once it runs.
 *     ProviderAdapter maps "active" to "running".
 *   - Tags are plain strings, and are created on the fly by the create call.
 *   - The root password is NOT returned by the API. If no ssh_keys are passed,
 *     DigitalOcean emails one to the account owner. We inject our deploy key
 *     with cloud-init (same approach as Hetzner), so the password is never
 *     stored by us.
 *   - Prices are USD.
 */

const API_BASE = "https://api.digitalocean.com/v2";
const TIMEOUT_MS = 20_000;
const PER_PAGE = 200;
const MAX_PAGES = 20;

/**
 * Images the provisioning scripts support. Installers.ts only accepts Ubuntu,
 * so Debian is deliberately not offered here.
 */
const SUPPORTED_IMAGES: Record<string, string> = {
    "ubuntu-24-04-x64": "Ubuntu 24.04 LTS",
    "ubuntu-22-04-x64": "Ubuntu 22.04 LTS",
};

export interface DigitalOceanRegion {
    id: string;
    label: string;
    country: string;
}

export interface DigitalOceanPlan {
    id: string;
    label: string;
    class: string;
    memory_mb: number;
    vcpus: number;
    disk_gb: number;
    monthly: number;
    hourly: number;
    currency: "USD";
}

export interface DigitalOceanImage {
    id: string;
    label: string;
}

export interface DigitalOceanInstance {
    id: number;
    label: string;
    status: string;
    region: string;
    type: string;
    ipv4: string[];
    tags: string[];
}

export interface CreateDigitalOceanInstanceInput {
    region: string;
    type: string;
    image: string;
    label: string;
    authorizedKeys: string[];
    tags?: string[];
}

export class DigitalOceanError extends Error {
    status: number;
    code: string;

    constructor(message: string, status: number, code = "") {
        super(message);
        this.name = "DigitalOceanError";
        this.status = status;
        this.code = code;
    }
}

interface RawDroplet {
    id: number;
    name: string;
    status: string;
    networks?: { v4?: { ip_address: string; type: string }[] };
    tags?: string[];
    region?: { slug: string };
    size_slug?: string;
}

function toInstance(raw: RawDroplet): DigitalOceanInstance {
    const publicV4 = (raw.networks?.v4 ?? [])
        .filter((n) => n.type === "public")
        .map((n) => n.ip_address);

    return {
        id: raw.id,
        label: raw.name,
        status: raw.status,
        region: raw.region?.slug ?? "",
        type: raw.size_slug ?? "",
        ipv4: publicV4,
        tags: raw.tags ?? [],
    };
}

/** Cloud-init that puts the keys on root. JSON strings are valid YAML scalars. */
function buildUserData(keys: string[]): string | undefined {
    if (keys.length === 0) return undefined;
    const lines = ["#cloud-config", "ssh_authorized_keys:"];
    for (const key of keys) lines.push(`  - ${JSON.stringify(key.trim())}`);
    return lines.join("\n") + "\n";
}

/**
 * Says WHY a fetch failed without ever including the request details, which
 * carry the token. Only the error name and the system error code are used.
 */
function describeNetworkFailure(error: unknown): string {
    const err = error as { name?: string; code?: string; cause?: { code?: string } } | null;

    if (err?.name === "TimeoutError" || err?.name === "AbortError") {
        return "timed out";
    }

    const code = err?.cause?.code ?? err?.code;
    return code ? String(code) : "network error";
}

async function request<T>(
    method: string,
    path: string,
    token: string,
    body?: unknown,
): Promise<T> {
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
        // Never include the request details here: they carry the token.
        throw new DigitalOceanError(
            `Could not reach the DigitalOcean API (${describeNetworkFailure(error)}).`,
            0,
        );
    }

    const text = await response.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // Non-JSON body (or an empty 204): fall through with json = null.
    }

    if (!response.ok) {
        const err = json as { id?: string; message?: string } | null;
        throw new DigitalOceanError(
            err?.message ?? `DigitalOcean API error (${response.status})`,
            response.status,
            err?.id ?? "",
        );
    }

    return json as T;
}

export class DigitalOceanClient {
    private token: string;

    constructor(token: string) {
        this.token = token;
    }

    /**
     * Throws DigitalOceanError (401/403) if the token is invalid.
     * A read-only token passes this check and only fails when creating a droplet.
     */
    async verify(): Promise<void> {
        await request("GET", "/droplets?per_page=1", this.token);
    }

    /** Follows links.pages.next until every page of `key` has been collected. */
    private async all<T>(path: string, key: string): Promise<T[]> {
        const out: T[] = [];
        const sep = path.includes("?") ? "&" : "?";

        for (let page = 1; page <= MAX_PAGES; page++) {
            const res = await request<Record<string, unknown>>(
                "GET",
                `${path}${sep}per_page=${PER_PAGE}&page=${page}`,
                this.token,
            );
            out.push(...((res[key] as T[]) ?? []));

            const next = (res.links as { pages?: { next?: string } } | undefined)?.pages?.next;
            if (!next) break;
        }

        return out;
    }

    async createInstance(input: CreateDigitalOceanInstanceInput): Promise<DigitalOceanInstance> {
        const res = await request<{ droplet: RawDroplet }>("POST", "/droplets", this.token, {
            name: input.label,
            region: input.region,
            size: input.type,
            image: input.image,
            user_data: buildUserData(input.authorizedKeys),
            tags: input.tags ?? [],
            ipv6: true,
            monitoring: false,
        });
        return toInstance(res.droplet);
    }

    async getInstance(id: number): Promise<DigitalOceanInstance> {
        const res = await request<{ droplet: RawDroplet }>("GET", `/droplets/${id}`, this.token);
        return toInstance(res.droplet);
    }

    /** Finds a droplet by tag (for example "tylix-provision-42"), or null. */
    async findByTag(tag: string): Promise<DigitalOceanInstance | null> {
        const res = await request<{ droplets: RawDroplet[] }>(
            "GET",
            `/droplets?tag_name=${encodeURIComponent(tag)}&per_page=1`,
            this.token,
        );
        return res.droplets.length > 0 ? toInstance(res.droplets[0]) : null;
    }

    async deleteInstance(id: number): Promise<void> {
        try {
            await request("DELETE", `/droplets/${id}`, this.token);
        } catch (error) {
            // Already gone is the outcome we wanted.
            if (error instanceof DigitalOceanError && error.status === 404) return;
            throw error;
        }
    }

    // ---- Catalog (needs a token on DigitalOcean) ----

    async regions(): Promise<DigitalOceanRegion[]> {
        const rows = await this.all<{ slug: string; name: string; available: boolean }>(
            "/regions",
            "regions",
        );

        return rows
            .filter((r) => r.available)
            .map((r) => ({ id: r.slug, label: r.name, country: "" }))
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    async plans(region?: string): Promise<DigitalOceanPlan[]> {
        const rows = await this.all<{
            slug: string;
            memory: number;
            vcpus: number;
            disk: number;
            price_monthly: number;
            price_hourly: number;
            regions: string[];
            available: boolean;
            description?: string;
        }>("/sizes", "sizes");

        const plans: DigitalOceanPlan[] = [];

        for (const t of rows) {
            if (!t.available || t.slug.startsWith("gpu")) continue;

            // A size that isn't listed for this region isn't offered there.
            if (region && !t.regions.includes(region)) continue;

            plans.push({
                id: t.slug,
                label: t.slug,
                class: t.description ?? "Droplet",
                memory_mb: t.memory,
                vcpus: t.vcpus,
                disk_gb: t.disk,
                monthly: Number(t.price_monthly),
                hourly: Number(t.price_hourly),
                currency: "USD",
            });
        }

        return plans.sort((a, b) => a.monthly - b.monthly);
    }

    async images(): Promise<DigitalOceanImage[]> {
        const rows = await this.all<{ slug: string | null; status?: string }>(
            "/images?type=distribution",
            "images",
        );

        const available = new Set(
            rows
                .filter((i) => i.slug && (i.status === undefined || i.status === "available"))
                .map((i) => i.slug as string),
        );

        return Object.keys(SUPPORTED_IMAGES)
            .filter((id) => available.has(id))
            .map((id) => ({ id, label: SUPPORTED_IMAGES[id] }));
    }
}