/**
 * Minimal UpCloud API client for the deployer (https://api.upcloud.com/1.3).
 *
 *   - Credentials are a username + password (use an API sub-account), stored as JSON
 *     in providers.credentials: { "username": "...", "password": "..." }
 *   - Machines are referenced by their UUID.
 *   - Images are logical ids ("ubuntu-24.04"). The template UUID is resolved by title
 *     when the machine is created.
 *   - We log in as root with the deploy key via login_user.ssh_keys.
 *   - A server must be STOPPED before it can be deleted, so deleteServer() stops it first.
 *   - Prices are not looked up (monthly = 0), currency is EUR.
 */

const BASE = "https://api.upcloud.com/1.3";
const TIMEOUT_MS = 20_000;
const MIN_DISK_GB = 25;
const STOP_TIMEOUT_MS = 90_000;

const IMAGES = [
    { id: "ubuntu-24.04", label: "Ubuntu 24.04", title: /^Ubuntu Server 24\.04/i },
    { id: "ubuntu-22.04", label: "Ubuntu 22.04", title: /^Ubuntu Server 22\.04/i },
];

const COUNTRY_FIX: Record<string, string> = { uk: "GB" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface UpCloudCredentials {
    username: string;
    password: string;
}
export interface UpCloudRegion { id: string; label: string; country: string }
export interface UpCloudPlan {
    id: string; label: string; class: string; memory_mb: number; vcpus: number;
    disk_gb: number; monthly: number; hourly: number; currency: "EUR";
}
export interface UpCloudImage { id: string; label: string }

export interface UpCloudInstance {
    uuid: string;
    /** started, maintenance (while building), stopped, error */
    state: string;
    /** Public IPv4, or "" until assigned. */
    ip: string;
}

export interface CreateUpCloudServerInput {
    provisionId: number;
    zone: string;
    plan: string;
    image: string;
    name: string;
    hostname: string;
    authorizedKeys: string[];
}

export class UpCloudError extends Error {
    status: number;
    code: string;

    constructor(message: string, status: number, code = "") {
        super(message);
        this.name = "UpCloudError";
        this.status = status;
        this.code = code;
    }

    /** Bad credentials, API access not enabled for the account, or IP not allowed. */
    get isAuth(): boolean {
        return this.status === 401 || this.status === 403;
    }

    get isTransient(): boolean {
        return this.status === 0 || this.status === 429 || this.status >= 500;
    }
}

export function parseUpCloudCredentials(secret: string): UpCloudCredentials {
    let data: { username?: unknown; password?: unknown } | null = null;
    try {
        data = JSON.parse(secret);
    } catch {
        /* handled below */
    }

    const username = typeof data?.username === "string" ? data.username.trim() : "";
    const password = typeof data?.password === "string" ? data.password : "";

    if (!username || !password) throw new Error("The stored UpCloud credentials are incomplete.");
    return { username, password };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toInstance(raw: Json): UpCloudInstance {
    const ips: Json[] = raw?.ip_addresses?.ip_address ?? [];
    const pub = ips.find((a) => a.access === "public" && a.family === "IPv4");
    return { uuid: String(raw.uuid), state: String(raw.state ?? ""), ip: pub?.address ?? "" };
}

export class UpCloudClient {
    private auth: string;

    constructor(creds: UpCloudCredentials) {
        this.auth = "Basic " + Buffer.from(`${creds.username}:${creds.password}`, "utf8").toString("base64");
    }

    private async request<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
        let res: Response;
        try {
            res = await fetch(BASE + path, {
                method,
                headers: {
                    Authorization: this.auth,
                    Accept: "application/json",
                    ...(body ? { "Content-Type": "application/json" } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch {
            throw new UpCloudError("Could not reach UpCloud.", 0);
        }

        if (res.status === 204) return {} as T;

        const text = await res.text();
        let data: Json = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            /* non-JSON error page */
        }

        if (!res.ok) {
            const e = data?.error;
            throw new UpCloudError(e?.error_message || `UpCloud API error (${res.status})`, res.status, e?.error_code ?? "");
        }
        return data as T;
    }

    /** Read-only. */
    async verify(): Promise<void> {
        await this.request("GET", "/account");
    }

    // ---- Catalog ----

    async regions(): Promise<UpCloudRegion[]> {
        const data = await this.request("GET", "/zone");
        const zones: Json[] = data?.zones?.zone ?? [];

        return zones
            .filter((z) => z.public !== "no")
            .map((z) => {
                const prefix = String(z.id).slice(0, 2).toLowerCase();
                return {
                    id: String(z.id),
                    label: String(z.description || z.id),
                    country: COUNTRY_FIX[prefix] ?? prefix.toUpperCase(),
                };
            })
            .sort((a, b) => a.label.localeCompare(b.label));
    }

    images(): UpCloudImage[] {
        return IMAGES.map((i) => ({ id: i.id, label: i.label }));
    }

    async plans(_region?: string): Promise<UpCloudPlan[]> {
        const data = await this.request("GET", "/plan");
        const plans: Json[] = data?.plans?.plan ?? [];

        const classOf = (name: string) =>
            name.startsWith("DEV-") ? "developer"
            : name.startsWith("HICPU-") ? "compute"
            : name.startsWith("HIMEM-") ? "memory"
            : name.startsWith("CN-") ? "cloud-native"
            : "general";

        return plans
            .map((p) => ({
                id: String(p.name),
                label: String(p.name),
                class: classOf(String(p.name)),
                memory_mb: Number(p.memory_amount ?? 0),
                vcpus: Number(p.core_number ?? 0),
                disk_gb: Number(p.storage_size ?? 0),
                monthly: 0, // prices are not looked up
                hourly: 0,
                currency: "EUR" as const,
            }))
            .sort((a, b) => a.memory_mb - b.memory_mb || a.vcpus - b.vcpus || a.id.localeCompare(b.id));
    }

    // ---- Machines ----

    private async resolveTemplate(imageId: string): Promise<string> {
        const image = IMAGES.find((i) => i.id === imageId);
        if (!image) throw new UpCloudError("That operating system isn't supported on UpCloud.", 400, "UnknownImage");

        const data = await this.request("GET", "/storage/template");
        const storages: Json[] = data?.storages?.storage ?? [];

        const match = storages
            .filter((s) => image.title.test(String(s.title ?? "")))
            .sort((a, b) => String(a.title).length - String(b.title).length)[0];

        if (!match?.uuid) throw new UpCloudError(`No ${image.label} template was found.`, 404, "NoTemplate");
        return String(match.uuid);
    }

    async createServer(input: CreateUpCloudServerInput): Promise<UpCloudInstance> {
        const plan = (await this.plans()).find((p) => p.id === input.plan);
        if (!plan) throw new UpCloudError("That plan isn't available.", 400, "UnknownPlan");

        const template = await this.resolveTemplate(input.image);

        const res = await this.request("POST", "/server", {
            server: {
                zone: input.zone,
                title: input.name,
                hostname: input.hostname,
                plan: input.plan,
                metadata: "yes",
                firewall: "off", // ufw on the server is the real firewall
                login_user: {
                    username: "root",
                    create_password: "no",
                    ssh_keys: { ssh_key: input.authorizedKeys.map((k) => k.trim()) },
                },
                storage_devices: {
                    storage_device: [
                        {
                            action: "clone",
                            storage: template,
                            title: `${input.name}-disk`,
                            size: Math.max(plan.disk_gb, MIN_DISK_GB),
                            tier: "maxiops",
                        },
                    ],
                },
                networking: {
                    interfaces: {
                        interface: [{ type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } }],
                    },
                },
                labels: {
                    label: [
                        { key: "tylix-provision", value: String(input.provisionId) },
                        { key: "managed-by", value: "tylix-deploy" },
                    ],
                },
            },
        });

        if (!res?.server?.uuid) throw new UpCloudError("UpCloud accepted the request but returned no server.", 502, "NoServer");
        return toInstance(res.server);
    }

    async getServer(uuid: string): Promise<UpCloudInstance> {
        const res = await this.request("GET", `/server/${encodeURIComponent(uuid)}`);
        return toInstance(res.server);
    }

    /**
     * Our own machine, found by label. The list call is filtered by label, but
     * every candidate is re-read and its labels checked, so an ignored filter
     * can never make us adopt someone else's server.
     */
    async findByLabel(provisionId: number): Promise<UpCloudInstance | null> {
        const wanted = String(provisionId);
        const list = await this.request("GET", `/server?label=${encodeURIComponent("tylix-provision=" + wanted)}`);
        const servers: Json[] = list?.servers?.server ?? [];

        for (const s of servers) {
            const detail = await this.request("GET", `/server/${encodeURIComponent(String(s.uuid))}`);
            const labels: Json[] = detail?.server?.labels?.label ?? [];
            if (labels.some((l) => l.key === "tylix-provision" && String(l.value) === wanted)) {
                return toInstance(detail.server);
            }
        }
        return null;
    }

    /** Stops (hard), waits for "stopped", then deletes the server with its disks. Already gone is success. */
    async deleteServer(uuid: string): Promise<void> {
        const id = encodeURIComponent(uuid);

        try {
            let state = (await this.getServer(uuid)).state;

            if (state !== "stopped") {
                if (state !== "stopping") {
                    await this.request("POST", `/server/${id}/stop`, { stop_server: { stop_type: "hard" } });
                }

                const deadline = Date.now() + STOP_TIMEOUT_MS;
                while (state !== "stopped" && Date.now() < deadline) {
                    await sleep(3_000);
                    try {
                        state = (await this.getServer(uuid)).state;
                    } catch (error) {
                        if (!(error instanceof UpCloudError && error.isTransient)) throw error;
                    }
                }
                if (state !== "stopped") throw new UpCloudError("The server didn't stop in time.", 504, "StopTimeout");
            }

            await this.request("DELETE", `/server/${id}?storages=1&backups=delete`);
        } catch (error) {
            if (error instanceof UpCloudError && error.status === 404) return;
            throw error;
        }
    }
}