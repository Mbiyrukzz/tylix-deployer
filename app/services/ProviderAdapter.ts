/**
 * Service: ProviderAdapter
 *
 * One interface over the cloud providers, so the ProvisionServer job, the
 * ProviderController and the catalog routes never branch on `kind` themselves.
 * Adding another provider means writing one more adapter here and adding
 * it to adapterFor() and PROVIDER_KINDS, nothing else in the job.
 *
 * The differences this hides:
 *   - Root password: Linode takes one we generate; Hetzner generates its own
 *     and returns it ONCE, in the create response; DigitalOcean, Vultr and AWS
 *     never return one (we log in with our deploy key, injected through cloud-init).
 *   - Idempotent retry: Linode uses a tag + exact label lookup; Hetzner uses a
 *     label selector (tylix-provision=<id>); DigitalOcean and Vultr use a tag;
 *     AWS uses the tylix-provision tag plus a ClientToken on create.
 *   - Catalog: Linode's catalog is public (static calls); every other provider
 *     needs the credentials for everything, so the adapter is built per secret.
 *   - Currency: Linode, DigitalOcean, Vultr and AWS prices are USD, Hetzner's are EUR (gross).
 *     AWS prices are not looked up (monthly is 0).
 *   - Status: DigitalOcean says "active" and Vultr "active"+power "running"
 *     where the others say "running"; the adapter normalises it.
 *   - REF: machine ids are strings everywhere in this file. Linode, Hetzner and
 *     DigitalOcean ids are numbers converted to and from strings at the edge;
 *     Vultr ids are UUIDs; AWS refs are "<region>/<instance-id>" because EC2 is regional.
 *   - AWS: the "secret" is the JSON stored in providers.credentials, not a single token.
 *     Use providerSecret(row) to get the right secret for any connection.
 */

import { CryptoService } from "./CryptoService.js";
import {
    LinodeClient,
    LinodeError,
    generateRootPassword,
    type LinodeInstance,
} from "./LinodeClient.js";
import { HetznerClient, HetznerError, type HetznerInstance } from "./HetznerClient.js";
import {
    DigitalOceanClient,
    DigitalOceanError,
    type DigitalOceanInstance,
} from "./DigitalOceanClient.js";
// VULTR: new client
import { VultrClient, VultrError, type VultrInstance } from "./VultrClient.js";
// AWS: new client
import { AwsClient, AwsError, parseAwsCredentials, type AwsInstance } from "./AwsClient.js";

// AWS: added to the union and the list
export type ProviderKind = "linode" | "hetzner" | "digitalocean" | "vultr" | "aws";

/** Every supported kind. Keep in sync with adapterFor() below. */
export const PROVIDER_KINDS: ProviderKind[] = ["linode", "hetzner", "digitalocean", "vultr", "aws"];

/** Display names, shared by the controllers and the catalog route. */
export const PROVIDER_NAMES: Record<string, string> = {
    linode: "Linode",
    hetzner: "Hetzner",
    digitalocean: "DigitalOcean",
    vultr: "Vultr",
    aws: "AWS",
};

export function providerName(kind: string): string {
    return PROVIDER_NAMES[kind] ?? "the provider";
}

/**
 * The decrypted secret to build an adapter with. Multi-field providers (AWS)
 * keep their JSON in `credentials`; the rest keep a single token in `api_token`.
 */
export function providerSecret(row: { api_token?: string | null; credentials?: string | null }): string {
    const stored = row.credentials || row.api_token || "";
    if (!stored) throw new Error("This connection has no stored credentials.");
    return CryptoService.decrypt(stored);
}

export interface CatalogRegion {
    id: string;
    label: string;
    country: string;
}

export interface CatalogPlan {
    id: string;
    label: string;
    class: string;
    memory_mb: number;
    vcpus: number;
    disk_gb: number;
    monthly: number;
    hourly: number;
    currency: "USD" | "EUR";
}

export interface CatalogImage {
    id: string;
    label: string;
}

/** The only instance fields the job cares about, whichever provider made it. */
export interface ProviderInstance {
    /** REF: the provider's id as a string (was `id: number`). */
    ref: string;
    status: string;
    /** First public IPv4, or "" while the provider hasn't assigned one yet. */
    ip: string;
}

/**
 * REF: the machine reference stored on a provision row, as a string.
 * Falls back to the old numeric column so rows created before instance_ref
 * existed still work. Returns "" when no machine exists yet.
 */
export function instanceRefOf(row: { instance_ref?: unknown; instance_id?: unknown }): string {
    const ref = String(row.instance_ref ?? "").trim();
    if (ref) return ref;

    const id = Number(row.instance_id);
    return Number.isFinite(id) && id > 0 ? String(id) : "";
}

export interface ProviderCreateInput {
    provisionId: number;
    name: string;
    region: string;
    plan: string;
    image: string;
    /** Null when the provider generates the password itself (Hetzner) or never exposes it (DigitalOcean, Vultr, AWS). */
    rootPassword: string | null;
    publicKey: string;
}

export interface ProviderAdapter {
    kind: ProviderKind;

    /** Throws if the credentials don't work. A read-only check on every provider. */
    verify(): Promise<void>;

    /** True when the error means the credentials are invalid or lack permission. */
    isAuthError(error: unknown): boolean;

    /** True for network failures, 5xx and rate limits: worth retrying a poll. */
    isTransient(error: unknown): boolean;

    /** "Linode: ..." / "Hetzner: ..." / ... for this provider's own errors, otherwise null. */
    describeError(error: unknown): string | null;

    /**
     * A root password we choose and store BEFORE creating anything, or null
     * when the provider generates one (or never exposes one).
     */
    presetRootPassword(): string | null;

    /**
     * Finds the machine a previous run of this provision already created, or null.
     * AWS: `region` is required, because EC2 can only be searched one region at a time.
     * The other providers ignore it.
     */
    findOurs(provisionId: number, name: string, region?: string): Promise<ProviderInstance | null>;

    /** Creates the machine. rootPassword is whatever must be stored (null if none exists). */
    create(input: ProviderCreateInput): Promise<{ instance: ProviderInstance; rootPassword: string | null }>;

    /** REF: takes the string reference (was `id: number`). */
    get(ref: string): Promise<ProviderInstance>;

    /** REF: takes the string reference. Deletes the machine. Already deleted counts as success. */
    remove(ref: string): Promise<void>;

    // ---- Catalog for the create-server form ----
    regions(): Promise<CatalogRegion[]>;
    plans(region?: string): Promise<CatalogPlan[]>;
    images(): Promise<CatalogImage[]>;
}

/** Hostname-safe names (RFC 1123, max 63 chars) for providers that use the name as a hostname. */
function hostnameSafe(name: string, fallback: string): string {
    const cleaned = name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+/, "")
        .slice(0, 63)
        .replace(/-+$/, "");
    return cleaned || fallback;
}

// ---------------------------------------------------------------------------
// Linode
// ---------------------------------------------------------------------------

// REF: id becomes ref (String)
function fromLinode(raw: LinodeInstance): ProviderInstance {
    return { ref: String(raw.id), status: raw.status, ip: raw.ipv4[0] ?? "" };
}

class LinodeAdapter implements ProviderAdapter {
    kind = "linode" as const;
    private client: LinodeClient;

    constructor(token: string) {
        this.client = new LinodeClient(token);
    }

    verify() {
        return this.client.verify();
    }

    isAuthError(error: unknown) {
        return error instanceof LinodeError && (error.status === 401 || error.status === 403);
    }

    isTransient(error: unknown) {
        return error instanceof LinodeError && (error.status === 0 || error.status >= 500);
    }

    describeError(error: unknown) {
        return error instanceof LinodeError ? `Linode: ${error.message}` : null;
    }

    // Linode wants us to send a password, so we make it up front (and the job
    // saves it encrypted before the create call).
    presetRootPassword() {
        return generateRootPassword();
    }

    async findOurs(provisionId: number, name: string) {
        const tag = `tylix-provision-${provisionId}`;
        const found = await this.client.findByLabel(name);

        if (!found) return null;

        // Same label but not our tag: someone else's machine. Never adopt it.
        if (!found.tags.includes(tag)) {
            throw new Error(`A Linode named "${name}" already exists in this account. Choose another name.`);
        }

        return fromLinode(found);
    }

    async create(input: ProviderCreateInput) {
        if (!input.rootPassword) {
            throw new Error("Internal error: Linode needs a root password before creating.");
        }

        const instance = await this.client.createInstance({
            region: input.region,
            type: input.plan,
            image: input.image,
            label: input.name,
            rootPassword: input.rootPassword,
            authorizedKeys: [input.publicKey],
            tags: [`tylix-provision-${input.provisionId}`, "tylix-deploy"],
        });

        return { instance: fromLinode(instance), rootPassword: input.rootPassword };
    }

    // REF: the client still wants a number, so convert at the edge.
    async get(ref: string) {
        return fromLinode(await this.client.getInstance(Number(ref)));
    }

    async remove(ref: string) {
        try {
            await this.client.deleteInstance(Number(ref));
        } catch (error) {
            if (error instanceof LinodeError && error.status === 404) return;
            throw error;
        }
    }

    regions() {
        return LinodeClient.regions();
    }

    async plans(region?: string) {
        const plans = await LinodeClient.plans(region);
        return plans.map((p) => ({ ...p, currency: "USD" as const }));
    }

    images() {
        return LinodeClient.images();
    }
}

// ---------------------------------------------------------------------------
// Hetzner
// ---------------------------------------------------------------------------

// REF: id becomes ref (String)
function fromHetzner(raw: HetznerInstance): ProviderInstance {
    return { ref: String(raw.id), status: raw.status, ip: raw.ipv4[0] ?? "" };
}

class HetznerAdapter implements ProviderAdapter {
    kind = "hetzner" as const;
    private client: HetznerClient;

    constructor(token: string) {
        this.client = new HetznerClient(token);
    }

    verify() {
        return this.client.verify();
    }

    isAuthError(error: unknown) {
        return error instanceof HetznerError && (error.status === 401 || error.status === 403);
    }

    // 429 is Hetzner's rate limit: a poll should wait and try again, not fail.
    isTransient(error: unknown) {
        return (
            error instanceof HetznerError &&
            (error.status === 0 || error.status === 429 || error.status >= 500)
        );
    }

    describeError(error: unknown) {
        return error instanceof HetznerError ? `Hetzner: ${error.message}` : null;
    }

    // Hetzner generates the password itself and returns it from create().
    presetRootPassword() {
        return null;
    }

    // We find our machine by label, never by name, so a name clash with
    // someone else's server can't make us adopt it.
    async findOurs(provisionId: number) {
        const found = await this.client.findByLabel(`tylix-provision=${provisionId}`);
        return found ? fromHetzner(found) : null;
    }

    async create(input: ProviderCreateInput) {
        const { instance, rootPassword } = await this.client.createInstance({
            region: input.region,
            type: input.plan,
            image: input.image,
            label: hostnameSafe(input.name, `server-${input.provisionId}`),
            authorizedKeys: [input.publicKey],
            labels: {
                "tylix-provision": String(input.provisionId),
                "managed-by": "tylix-deploy",
            },
        });

        return { instance: fromHetzner(instance), rootPassword };
    }

    // REF: convert at the edge
    async get(ref: string) {
        return fromHetzner(await this.client.getInstance(Number(ref)));
    }

    remove(ref: string) {
        return this.client.deleteInstance(Number(ref)); // already treats 404 as success
    }

    regions() {
        return this.client.regions();
    }

    plans(region?: string) {
        return this.client.plans(region);
    }

    images() {
        return this.client.images();
    }
}

// ---------------------------------------------------------------------------
// DigitalOcean
// ---------------------------------------------------------------------------

// REF: id becomes ref (String)
function fromDigitalOcean(raw: DigitalOceanInstance): ProviderInstance {
    return {
        ref: String(raw.id),
        // The job waits for "running" on every provider; DigitalOcean calls it "active".
        status: raw.status === "active" ? "running" : raw.status,
        ip: raw.ipv4[0] ?? "",
    };
}

class DigitalOceanAdapter implements ProviderAdapter {
    kind = "digitalocean" as const;
    private client: DigitalOceanClient;

    constructor(token: string) {
        this.client = new DigitalOceanClient(token);
    }

    verify() {
        return this.client.verify();
    }

    isAuthError(error: unknown) {
        return error instanceof DigitalOceanError && (error.status === 401 || error.status === 403);
    }

    // 429 is DigitalOcean's rate limit: a poll should wait and try again, not fail.
    isTransient(error: unknown) {
        return (
            error instanceof DigitalOceanError &&
            (error.status === 0 || error.status === 429 || error.status >= 500)
        );
    }

    describeError(error: unknown) {
        return error instanceof DigitalOceanError ? `DigitalOcean: ${error.message}` : null;
    }

    // The API neither accepts nor returns a root password. Login is by deploy key.
    presetRootPassword() {
        return null;
    }

    // Found by tag, never by name, so a name clash can't make us adopt someone else's droplet.
    async findOurs(provisionId: number) {
        const found = await this.client.findByTag(`tylix-provision-${provisionId}`);
        return found ? fromDigitalOcean(found) : null;
    }

    async create(input: ProviderCreateInput) {
        const instance = await this.client.createInstance({
            region: input.region,
            type: input.plan,
            image: input.image,
            label: hostnameSafe(input.name, `server-${input.provisionId}`),
            authorizedKeys: [input.publicKey],
            tags: [`tylix-provision-${input.provisionId}`, "tylix-deploy"],
        });

        return { instance: fromDigitalOcean(instance), rootPassword: null };
    }

    // REF: convert at the edge
    async get(ref: string) {
        return fromDigitalOcean(await this.client.getInstance(Number(ref)));
    }

    remove(ref: string) {
        return this.client.deleteInstance(Number(ref)); // already treats 404 as success
    }

    regions() {
        return this.client.regions();
    }

    plans(region?: string) {
        return this.client.plans(region);
    }

    images() {
        return this.client.images();
    }
}

// ---------------------------------------------------------------------------
// Vultr (VULTR: new)
// ---------------------------------------------------------------------------

function fromVultr(raw: VultrInstance): ProviderInstance {
    // A Vultr instance is only usable when it is both "active" and powered on.
    const running = raw.status === "active" && raw.power_status === "running";

    return {
        ref: raw.id, // already a UUID string
        status: running ? "running" : raw.status,
        // Vultr reports 0.0.0.0 until the address is assigned.
        ip: raw.main_ip && raw.main_ip !== "0.0.0.0" ? raw.main_ip : "",
    };
}

class VultrAdapter implements ProviderAdapter {
    kind = "vultr" as const;
    private client: VultrClient;

    constructor(token: string) {
        this.client = new VultrClient(token);
    }

    verify() {
        return this.client.verify();
    }

    // 401/403 also covers Vultr's IP access list, which the help text tells users about.
    isAuthError(error: unknown) {
        return error instanceof VultrError && (error.status === 401 || error.status === 403);
    }

    // 429 is Vultr's rate limit: a poll should wait and try again, not fail.
    isTransient(error: unknown) {
        return (
            error instanceof VultrError &&
            (error.status === 0 || error.status === 429 || error.status >= 500)
        );
    }

    describeError(error: unknown) {
        return error instanceof VultrError ? `Vultr: ${error.message}` : null;
    }

    // We log in with the deploy key injected through cloud-init. No password is stored.
    presetRootPassword() {
        return null;
    }

    // Found by tag, never by name, so a name clash can't make us adopt someone else's instance.
    async findOurs(provisionId: number) {
        const found = await this.client.findByTag(`tylix-provision-${provisionId}`);
        return found ? fromVultr(found) : null;
    }

    async create(input: ProviderCreateInput) {
        const instance = await this.client.createInstance({
            region: input.region,
            type: input.plan,
            image: input.image,
            label: input.name,
            hostname: hostnameSafe(input.name, `server-${input.provisionId}`),
            authorizedKeys: [input.publicKey],
            tags: [`tylix-provision-${input.provisionId}`, "tylix-deploy"],
        });

        return { instance: fromVultr(instance), rootPassword: null };
    }

    async get(ref: string) {
        return fromVultr(await this.client.getInstance(ref));
    }

    remove(ref: string) {
        return this.client.deleteInstance(ref); // 404 already counts as success
    }

    regions() {
        return this.client.regions();
    }

    plans(region?: string) {
        return this.client.plans(region);
    }

    images() {
        return this.client.images();
    }
}

// ---------------------------------------------------------------------------
// AWS (AWS: new)
// ---------------------------------------------------------------------------

// The ref is already "<region>/<instance-id>", and EC2's "running" needs no mapping.
function fromAws(raw: AwsInstance): ProviderInstance {
    return { ref: raw.ref, status: raw.state, ip: raw.ip };
}

class AwsAdapter implements ProviderAdapter {
    kind = "aws" as const;
    private client: AwsClient;

    // `secret` is the credentials JSON (see providerSecret). Throws if it is incomplete.
    constructor(secret: string) {
        this.client = new AwsClient(parseAwsCredentials(secret));
    }

    verify() {
        return this.client.verify();
    }

    // Covers bad keys and missing IAM permissions (UnauthorizedOperation).
    isAuthError(error: unknown) {
        return error instanceof AwsError && error.isAuth;
    }

    // Also true while a brand-new instance is not yet visible (InvalidInstanceID.NotFound).
    isTransient(error: unknown) {
        return error instanceof AwsError && error.isTransient;
    }

    describeError(error: unknown) {
        return error instanceof AwsError ? `AWS: ${error.message}` : null;
    }

    // EC2 has no root password. Login is by the deploy key injected through cloud-init.
    presetRootPassword() {
        return null;
    }

    // Found by the tylix-provision tag in that one region, never by name.
    async findOurs(provisionId: number, _name: string, region?: string) {
        if (!region) throw new Error("Internal error: AWS needs the region to look for an existing machine.");

        const found = await this.client.findByTag(region, provisionId);
        return found ? fromAws(found) : null;
    }

    async create(input: ProviderCreateInput) {
        const instance = await this.client.createInstance({
            provisionId: input.provisionId,
            region: input.region,
            type: input.plan,
            image: input.image,
            name: input.name,
            authorizedKeys: [input.publicKey],
        });

        return { instance: fromAws(instance), rootPassword: null };
    }

    async get(ref: string) {
        return fromAws(await this.client.getInstance(ref));
    }

    remove(ref: string) {
        return this.client.deleteInstance(ref); // "not found" already counts as success
    }

    regions() {
        return this.client.regions();
    }

    async plans(region?: string) {
        return this.client.plans(region);
    }

    async images() {
        return this.client.images();
    }
}

// ---------------------------------------------------------------------------

/**
 * Builds the adapter for a stored provider kind. Throws on an unknown kind.
 * `secret` is a single token for most providers, and the credentials JSON for AWS.
 */
export function adapterFor(kind: string, secret: string): ProviderAdapter {
    switch (kind) {
        case "linode":
            return new LinodeAdapter(secret);
        case "hetzner":
            return new HetznerAdapter(secret);
        case "digitalocean":
            return new DigitalOceanAdapter(secret);
        case "vultr": // VULTR
            return new VultrAdapter(secret);
        case "aws": // AWS
            return new AwsAdapter(secret);
        default:
            throw new Error(`Unsupported provider: ${kind}`);
    }
}