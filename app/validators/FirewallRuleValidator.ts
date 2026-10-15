/**
 * Feature: Firewall rule (hand-written validator)
 *
 * name, source, protocol and port are interpolated into a `ufw` command that
 * runs on the server, so each is checked against a strict pattern. Nothing
 * with a space-separated surprise, quote or shell metacharacter gets through.
 */

import { isIP } from "node:net";

export const TYPES = ["allow", "deny"];
export const PROTOCOLS = ["tcp", "udp"];

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,48}$/;

export interface NormalizedRule {
    name: string;
    type: string;
    source: string;
    protocol: string;
    port: string;
}

export function normalizeRule(data: Record<string, unknown>): NormalizedRule {
    const str = (value: unknown) =>
        typeof value === "string" || typeof value === "number" ? String(value).trim() : "";

    let source = str(data.source).toLowerCase();
    if (source === "" || source === "0.0.0.0/0" || source === "::/0") source = "any";

    return {
        name: str(data.name),
        type: str(data.type).toLowerCase(),
        source,
        protocol: str(data.protocol).toLowerCase(),
        port: str(data.port),
    };
}

/** "80" -> {80,80}, "6000:6010" -> {6000,6010}, anything else -> null. */
export function parsePort(port: string): { from: number; to: number } | null {
    const m = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(port);
    if (!m) return null;

    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);

    if (from < 1 || to > 65535 || from > to) return null;
    return { from, to };
}

function validSource(source: string): boolean {
    if (source === "any") return true;

    const parts = source.split("/");
    if (parts.length > 2) return false;

    const version = isIP(parts[0]);
    if (version === 0) return false;

    if (parts.length === 2) {
        if (!/^\d{1,3}$/.test(parts[1])) return false;
        if (Number(parts[1]) > (version === 4 ? 32 : 128)) return false;
    }
    return true;
}

export function validateRule(data: Record<string, unknown>) {
    const errors: Record<string, string[]> = {};
    const fail = (field: string, message: string) => {
        if (!errors[field]) errors[field] = [];
        errors[field].push(message);
    };

    const input = normalizeRule(data ?? {});

    if (!NAME.test(input.name)) {
        fail("name", "Use up to 49 letters, numbers, spaces, dots, dashes or underscores.");
    }
    if (!TYPES.includes(input.type)) fail("type", "Choose allow or deny.");
    if (!PROTOCOLS.includes(input.protocol)) fail("protocol", "Choose tcp or udp.");
    if (!validSource(input.source)) {
        fail("source", 'Use "any", an IP address, or a CIDR such as 203.0.113.0/24.');
    }
    if (!parsePort(input.port)) {
        fail("port", "Enter a port (1-65535) or a range like 6000:6010.");
    }

    return { valid: Object.keys(errors).length === 0, errors };
}