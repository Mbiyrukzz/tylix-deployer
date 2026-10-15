/**
 * Service: ProviderAdapter
 *
 * One interface over the cloud providers, so the ProvisionServer job, the
 * ProviderController and the catalog routes never branch on `kind` themselves.
 * Adding a third provider later means writing one more adapter here and adding
 * it to adapterFor(), nothing else.
 *
 * The differences this hides:
 *   - Root password: Linode takes one we generate; Hetzner generates its own
 *     and returns it ONCE, in the create response.
 *   - Idempotent retry: Linode uses a tag + exact label lookup; Hetzner uses a
 *     label selector (tylix-provision=<id>).
 *   - Catalog: Linode's catalog is public (static calls); Hetzner needs the
 *     token for everything, so the adapter is built per token.
 *   - Currency: Linode prices are USD, Hetzner's are EUR (gross).
 */

import {
    LinodeClient,
    LinodeError,
    generateRootPassword,
    type LinodeInstance,
} from "./LinodeClient.js";
import { HetznerClient, HetznerError, type HetznerInstance } from "./HetznerClient.js";

export type ProviderKind = "linode" | "hetzner";

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
    id: number;
    status: string;
    /** First public IPv4, or "" while the provider hasn't assigned one yet. */
    ip: string;
}

export interface ProviderCreateInput {
    provisionId: number;
    name: string;
    region: string;
    plan: string;
    image: string;
    /** Null when the provider generates the password itself (Hetzner). */
    rootPassword: string | null;
    publicKey: string;
}

export interface ProviderAdapter {
    kind: ProviderKind;

    /** Throws if the token doesn't work. A read-only check on both providers. */
    verify(): Promise<void>;

    /** True when the error means the token is invalid or lacks permission. */
    isAuthError(error: unknown): boolean;

    /** True for network failures, 5xx and rate limits: worth retrying a poll. */
    isTransient(error: unknown): boolean;

    /** "Linode: ..." / "Hetzner: ..." for this provider's own errors, otherwise null. */
    describeError(error: unknown): string | null;

    /**
     * A root password we choose and store BEFORE creating anything, or null
     * when the provider generates one and hands it back from create().
     */
    presetRootPassword(): string | null;

    /** Finds the machine a previous run of this provision already created, or null. */
    findOurs(provisionId: number, name: string): Promise<ProviderInstance | null>;

    /** Creates the machine. rootPassword is whatever must be stored (null if none exists). */
    create(input: ProviderCreateInput): Promise<{ instance: ProviderInstance; rootPassword: string | null }>;

    get(id: number): Promise<ProviderInstance>;

    /** Deletes the machine. Already deleted counts as success. */
    remove(id: number): Promise<void>;

    // ---- Catalog for the create-server form ----
    regions(): Promise<CatalogRegion[]>;
    plans(region?: string): Promise<CatalogPlan[]>;
    images(): Promise<CatalogImage[]>;
}

// ---------------------------------------------------------------------------
// Linode
// ---------------------------------------------------------------------------

function fromLinode(raw: LinodeInstance): ProviderInstance {
    return { id: raw.id, status: raw.status, ip: raw.ipv4[0] ?? "" };
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

    async get(id: number) {
        return fromLinode(await this.client.getInstance(id));
    }

    async remove(id: number) {
        try {
            await this.client.deleteInstance(id);
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

function fromHetzner(raw: HetznerInstance): ProviderInstance {
    return { id: raw.id, status: raw.status, ip: raw.ipv4[0] ?? "" };
}

/** Hetzner server names must be valid hostnames (RFC 1123), max 63 chars. */
function hostnameSafe(name: string, fallback: string): string {
    const cleaned = name
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+/, "")
        .slice(0, 63)
        .replace(/-+$/, "");
    return cleaned || fallback;
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

    async get(id: number) {
        return fromHetzner(await this.client.getInstance(id));
    }

    remove(id: number) {
        return this.client.deleteInstance(id); // already treats 404 as success
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

/** Builds the adapter for a stored provider kind. Throws on an unknown kind. */
export function adapterFor(kind: string, token: string): ProviderAdapter {
    switch (kind) {
        case "linode":
            return new LinodeAdapter(token);
        case "hetzner":
            return new HetznerAdapter(token);
        default:
            throw new Error(`Unsupported provider: ${kind}`);
    }
}
