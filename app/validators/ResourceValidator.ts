/**
 * Feature: Provider resources (hand-written validator)
 *
 * Shape checks only. Whether the provider accepts the request is decided by
 * its API, and its message is passed back to the form.
 */

export const MACHINE_ACTIONS = ["boot", "shutdown", "reboot"];
export const RULE_PROTOCOLS = ["TCP", "UDP", "ICMP", "ESP", "GRE"];

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{2,31}$/;
const ADDRESS = /^[0-9a-f:.]+(\/\d{1,3})?$/i;
const PORTS = /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/;
const HOSTNAME = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+\.?$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

const str = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

function collect() {
    const errors: Record<string, string[]> = {};
    const fail = (field: string, message: string) => {
        if (!errors[field]) errors[field] = [];
        errors[field].push(message);
    };
    return { errors, fail };
}

const done = (errors: Record<string, string[]>) => ({ valid: Object.keys(errors).length === 0, errors });

function checkName(label: string, fail: (f: string, m: string) => void, field = "label") {
    if (!label) fail(field, "Enter a name.");
    else if (!NAME.test(label)) {
        fail(field, "Use 3 to 32 letters, numbers, hyphens, dots or underscores. Start with a letter or number.");
    }
}

// ---- Machines ----

export function validateMachineAction(action: unknown) {
    return MACHINE_ACTIONS.includes(str(action));
}

// ---- Firewalls ----

export function normalizeFirewallCreate(data: Record<string, unknown>) {
    return { label: str(data?.label) };
}

export function validateFirewallCreate(data: Record<string, unknown>) {
    const { errors, fail } = collect();
    checkName(normalizeFirewallCreate(data).label, fail);
    return done(errors);
}

export interface NormalizedRule {
    direction: "in" | "out";
    protocol: string;
    ports: string;
    addresses: string[];
    action: "ACCEPT" | "DROP";
    label: string;
}

export interface NormalizedRules {
    inboundPolicy: "ACCEPT" | "DROP";
    outboundPolicy: "ACCEPT" | "DROP";
    rules: NormalizedRule[];
}

function addressList(value: unknown): string[] {
    const raw = Array.isArray(value) ? value.map(str) : str(value).split(/[\s,]+/);
    return raw.map((a) => a.trim()).filter((a) => a !== "");
}

export function normalizeFirewallRules(data: Record<string, unknown>): NormalizedRules {
    const list = Array.isArray(data?.rules) ? (data.rules as Record<string, unknown>[]) : [];

    return {
        inboundPolicy: str(data?.inbound_policy).toUpperCase() === "ACCEPT" ? "ACCEPT" : "DROP",
        outboundPolicy: str(data?.outbound_policy).toUpperCase() === "DROP" ? "DROP" : "ACCEPT",
        rules: list.map((r) => ({
            direction: str(r?.direction).toLowerCase() === "out" ? "out" : "in",
            protocol: str(r?.protocol).toUpperCase(),
            ports: str(r?.ports).replace(/\s+/g, ""),
            addresses: addressList(r?.addresses),
            action: str(r?.action).toUpperCase() === "DROP" ? "DROP" : "ACCEPT",
            label: str(r?.label),
        })),
    };
}

export function validateFirewallRules(data: Record<string, unknown>) {
    const { errors, fail } = collect();

    if (!Array.isArray(data?.rules)) {
        fail("rules", "Send the rules as a list.");
        return done(errors);
    }

    const input = normalizeFirewallRules(data);

    if (input.rules.length > 50) fail("rules", "A firewall can hold at most 50 rules.");

    input.rules.forEach((r, i) => {
        const n = `Rule ${i + 1}: `;

        if (!RULE_PROTOCOLS.includes(r.protocol)) {
            fail("rules", `${n}choose TCP, UDP, ICMP, ESP or GRE.`);
        }

        if (r.protocol === "TCP" || r.protocol === "UDP") {
            if (!PORTS.test(r.ports)) {
                fail("rules", `${n}enter ports like 22, 80,443 or 8000-8100.`);
            } else {
                const nums = r.ports.split(/[-,]/).map(Number);
                if (nums.some((p) => p < 1 || p > 65535)) fail("rules", `${n}ports must be between 1 and 65535.`);
            }
        }

        if (r.addresses.length === 0) {
            fail("rules", `${n}enter at least one address, like 0.0.0.0/0 or 203.0.113.10/32.`);
        } else if (r.addresses.some((a) => !ADDRESS.test(a))) {
            fail("rules", `${n}addresses must be IPs or CIDR ranges, like 10.0.0.0/8.`);
        }

        if (r.label.length > 100) fail("rules", `${n}the label is too long.`);
    });

    return done(errors);
}

// ---- Volumes ----

export interface NormalizedVolume {
    label: string;
    sizeGb: number;
    region: string;
    machineId: string;
}

export function normalizeVolumeCreate(data: Record<string, unknown>): NormalizedVolume {
    const size = data?.size;
    return {
        label: str(data?.label),
        sizeGb: size === undefined || size === null || size === "" ? 0 : Number(size),
        region: str(data?.region),
        machineId: str(data?.machine_id),
    };
}

export function validateVolumeCreate(data: Record<string, unknown>) {
    const { errors, fail } = collect();
    const input = normalizeVolumeCreate(data ?? {});

    checkName(input.label, fail);

    if (!Number.isInteger(input.sizeGb) || input.sizeGb < 10 || input.sizeGb > 10240) {
        fail("size", "Size must be a whole number of GB between 10 and 10240.");
    }

    if (!input.machineId && !input.region) fail("region", "Choose a region, or a server to create it for.");
    if (input.machineId && !ID.test(input.machineId)) fail("machine_id", "Choose a server.");

    return done(errors);
}

export function normalizeMachineRef(data: Record<string, unknown>) {
    return { machineId: str(data?.machine_id) };
}

export function validateMachineRef(data: Record<string, unknown>) {
    const { errors, fail } = collect();
    if (!ID.test(normalizeMachineRef(data ?? {}).machineId)) fail("machine_id", "Choose a server.");
    return done(errors);
}

// ---- Images ----

export function normalizeImageCreate(data: Record<string, unknown>) {
    return { machineId: str(data?.machine_id), label: str(data?.label) };
}

export function validateImageCreate(data: Record<string, unknown>) {
    const { errors, fail } = collect();
    const input = normalizeImageCreate(data ?? {});

    if (!ID.test(input.machineId)) fail("machine_id", "Choose a server.");
    checkName(input.label, fail);

    return done(errors);
}

export function normalizeImageRename(data: Record<string, unknown>) {
    return { label: str(data?.label) };
}

export function validateImageRename(data: Record<string, unknown>) {
    const { errors, fail } = collect();
    checkName(normalizeImageRename(data ?? {}).label, fail);
    return done(errors);
}

// ---- IPs ----

export function normalizeIpAllocate(data: Record<string, unknown>) {
    return {
        version: str(data?.version).toLowerCase() === "v6" ? ("v6" as const) : ("v4" as const),
        region: str(data?.region),
        machineId: str(data?.machine_id),
        label: str(data?.label),
    };
}

export function validateIpAllocate(data: Record<string, unknown>) {
    const { errors, fail } = collect();
    const input = normalizeIpAllocate(data ?? {});

    if (!input.machineId && !input.region) fail("region", "Choose a region, or a server to attach it to.");
    if (input.machineId && !ID.test(input.machineId)) fail("machine_id", "Choose a server.");
    if (input.label && !NAME.test(input.label)) fail("label", "Use 3 to 32 letters, numbers, hyphens, dots or underscores.");

    return done(errors);
}

export function normalizeRdns(data: Record<string, unknown>) {
    return { rdns: str(data?.rdns).toLowerCase().replace(/\.$/, "") };
}

export function validateRdns(data: Record<string, unknown>) {
    const { errors, fail } = collect();
    const { rdns } = normalizeRdns(data ?? {});

    // Empty clears the reverse DNS.
    if (rdns !== "" && (rdns.length > 253 || !HOSTNAME.test(rdns))) {
        fail("rdns", "Enter a hostname like mail.example.com, or leave it empty to reset.");
    }

    return done(errors);
}