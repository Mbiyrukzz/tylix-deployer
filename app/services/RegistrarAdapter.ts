/**
 * Service: RegistrarAdapter
 *
 * One interface over the domain registrars / DNS hosts, the same idea as
 * ProviderAdapter for clouds. The difference: registrars are wildly uneven, so
 * every adapter declares which FEATURES it really supports, and the controller
 * and UI only offer those. Nothing is faked. If a registrar has no API for
 * something (most have none for email or billing), the section simply isn't shown.
 *
 * Features:
 *   domains      list the domains in the account (with expiry where the API gives it)
 *   dns          list / add / edit / delete DNS records
 *   nameservers  read the nameservers (and set them, if `setNameservers` exists)
 *   settings     auto-renew and transfer lock (`setAutoRenew`, `setLock`)
 *   forwarding   email forwarding rules (`forwarders`, `addForwarder`, `removeForwarder`)
 *   billing      account balance and/or billing history (`billing`)
 *
 * NOT in this slice on purpose: register / renew / transfer. Those spend money,
 * so they need a price quote + typed confirmation flow first.
 *
 * Credentials: single-token kinds keep the token in registrars.api_token;
 * multi-field kinds keep JSON in registrars.credentials. registrarSecret(row)
 * returns whichever applies, decrypted.
 */

import { CryptoService } from "./CryptoService.js";
import { PorkbunAdapter } from "./registrars/porkbun.js";
import { CloudflareAdapter } from "./registrars/cloudflare.js";
import { GoDaddyAdapter } from "./registrars/godaddy.js";
import { NamecheapAdapter } from "./registrars/namecheap.js";
import { DynadotAdapter } from "./registrars/dynadot.js";
import { NameComAdapter } from "./registrars/namecom.js";
import { SpaceshipAdapter } from "./registrars/spaceship.js";
import { Route53Adapter } from "./registrars/route53.js";

export type RegistrarKind =
    | "porkbun"
    | "cloudflare"
    | "godaddy"
    | "namecheap"
    | "dynadot"
    | "namecom"
    | "spaceship"
    | "route53";
export type RegistrarFeature = "domains" | "dns" | "nameservers" | "settings" | "forwarding" | "billing";

export const REGISTRAR_KINDS: RegistrarKind[] = [
    "porkbun",
    "cloudflare",
    "godaddy",
    "namecheap",
    "dynadot",
    "namecom",
    "spaceship",
    "route53",
];

export const REGISTRAR_NAMES: Record<string, string> = {
    porkbun: "Porkbun",
    cloudflare: "Cloudflare",
    godaddy: "GoDaddy",
    namecheap: "Namecheap",
    dynadot: "Dynadot",
    namecom: "Name.com",
    spaceship: "Spaceship",
    route53: "Route 53",
};

/** What each kind supports. The UI reads this through the registrar's `features` field. */
export const REGISTRAR_FEATURES: Record<RegistrarKind, RegistrarFeature[]> = {
    porkbun: ["domains", "dns", "nameservers"],
    cloudflare: ["domains", "dns", "nameservers", "forwarding", "billing"],
    godaddy: ["domains", "dns", "nameservers", "settings"],
    namecheap: ["domains", "dns", "nameservers", "billing"],
    dynadot: ["domains", "dns", "nameservers", "billing"],
    namecom: ["domains", "dns", "nameservers", "settings"],
    spaceship: ["domains", "dns", "nameservers", "settings"],
    route53: ["domains", "dns", "nameservers", "settings", "billing"],
};

export function registrarName(kind: string): string {
    return REGISTRAR_NAMES[kind] ?? "the registrar";
}

export function featuresOf(kind: string): RegistrarFeature[] {
    return REGISTRAR_FEATURES[kind as RegistrarKind] ?? [];
}

export function registrarSecret(row: { api_token?: string | null; credentials?: string | null }): string {
    const stored = row.credentials || row.api_token || "";
    if (!stored) throw new Error("This connection has no stored credentials.");
    return CryptoService.decrypt(stored);
}

export interface DomainSummary {
    /** What the other calls take as `domainId`: the domain name, or a zone id (Cloudflare). */
    id: string;
    name: string;
    status: string;
    /** ISO date or "" when the registrar doesn't say (Cloudflare zones have no expiry). */
    expires: string;
    /** null = the registrar doesn't report it. */
    autoRenew: boolean | null;
    locked: boolean | null;
}

export interface DnsRecord {
    id: string;
    type: string;
    /** Relative to the zone: "@" for the apex, "www" for www.example.com. */
    name: string;
    value: string;
    ttl: number;
    priority: number | null;
    /** Cloudflare only. */
    proxied?: boolean;
}

export type DnsRecordInput = Omit<DnsRecord, "id">;

export interface Forwarder {
    id: string;
    from: string;
    to: string;
    enabled: boolean;
}

export interface BillingLine {
    id: string;
    /** ISO date (YYYY-MM-DD). */
    date: string;
    description: string;
    /** Negative for refunds / credits where the registrar reports them that way. */
    amount: number;
    currency: string;
}

export interface BillingSummary {
    /** null = the registrar's API doesn't report an account balance. */
    balance: { amount: number; currency: string } | null;
    /** Newest first. Empty when the registrar only reports a balance. */
    lines: BillingLine[];
}

export interface RegistrarAdapter {
    kind: RegistrarKind;
    features: RegistrarFeature[];

    /** Throws if the credentials don't work. Read-only on every registrar. */
    verify(): Promise<void>;
    isAuthError(error: unknown): boolean;
    isTransient(error: unknown): boolean;
    /** "Porkbun: ..." for this registrar's own errors, otherwise null. */
    describeError(error: unknown): string | null;

    domains(): Promise<DomainSummary[]>;

    records(domainId: string): Promise<DnsRecord[]>;
    addRecord(domainId: string, input: DnsRecordInput): Promise<DnsRecord>;
    updateRecord(domainId: string, recordId: string, input: DnsRecordInput): Promise<DnsRecord>;
    removeRecord(domainId: string, recordId: string): Promise<void>;

    nameservers(domainId: string): Promise<string[]>;
    setNameservers?(domainId: string, servers: string[]): Promise<void>;

    setAutoRenew?(domainId: string, on: boolean): Promise<void>;
    setLock?(domainId: string, on: boolean): Promise<void>;

    forwarders?(domainId: string): Promise<Forwarder[]>;
    addForwarder?(domainId: string, from: string, to: string): Promise<Forwarder>;
    removeForwarder?(domainId: string, forwarderId: string): Promise<void>;

    billing?(): Promise<BillingSummary>;
}

/** Builds the adapter for a stored kind. Throws on an unknown kind or incomplete credentials. */
export function registrarFor(kind: string, secret: string): RegistrarAdapter {
    switch (kind) {
        case "porkbun":
            return new PorkbunAdapter(secret);
        case "cloudflare":
            return new CloudflareAdapter(secret);
        case "godaddy":
            return new GoDaddyAdapter(secret);
        case "namecheap":
            return new NamecheapAdapter(secret);
        case "dynadot":
            return new DynadotAdapter(secret);
        case "namecom":
            return new NameComAdapter(secret);
        case "spaceship":
            return new SpaceshipAdapter(secret);
        case "route53":
            return new Route53Adapter(secret);
        default:
            throw new Error(`Unsupported registrar: ${kind}`);
    }
}