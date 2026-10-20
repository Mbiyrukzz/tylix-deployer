/**
 * Seeds the default rules (SSH, HTTP, HTTPS) if the server has none,
 * applies every rule, and turns ufw on, but only once SSH is confirmed allowed.
 * Used by the Sync button and by the ProvisionServer job.
 */

import { ServerFirewallRule } from "../models/ServerFirewallRule.js";
import { FirewallService } from "./FirewallService.js";
import { parsePort } from "../validators/FirewallRuleValidator.js";
import type { SshTarget } from "./Ssh.js";

interface RuleRow {
    id: number;
    server_id: number;
    name: string;
    type: string;
    source: string;
    protocol: string;
    port: string;
    status: string;
    error: string;
    [key: string]: unknown;
}

export interface SyncResult {
    failed: number;
    enableError: string;
}

async function rulesOf(serverId: number): Promise<RuleRow[]> {
    const all = (await ServerFirewallRule.all()) as RuleRow[];
    return all.filter((r) => Number(r.server_id) === serverId).sort((a, b) => a.id - b.id);
}

function coversPort(rule: RuleRow, port: number): boolean {
    if (rule.protocol !== "tcp") return false;
    const range = parsePort(String(rule.port));
    return Boolean(range && port >= range.from && port <= range.to);
}

export async function syncFirewall(
server: { id: number; user_id: number; team_id?: number | null; port: number },    target: SshTarget,
): Promise<SyncResult> {
    const sshPort = Number(server.port);
    let rules = await rulesOf(server.id);

    if (rules.length === 0) {
        const defaults = [
            { name: "SSH", port: String(sshPort) },
            { name: "HTTP", port: "80" },
            { name: "HTTPS", port: "443" },
        ];
        for (const d of defaults) {
            await ServerFirewallRule.create({
    user_id: server.user_id,
    ...(server.team_id ? { team_id: Number(server.team_id) } : {}),
    server_id: server.id,
                name: d.name,
                type: "allow",
                source: "any",
                protocol: "tcp",
                port: d.port,
                status: "pending",
                error: "",
            });
        }
        rules = await rulesOf(server.id);
    }

    // Allows first (SSH is first), denies after so they land on top.
    const ordered = [
        ...rules.filter((r) => r.type === "allow"),
        ...rules.filter((r) => r.type === "deny"),
    ];

    let failed = 0;
    for (const r of ordered) {
        const applied = await FirewallService.apply(target, r);
        if (!applied.ok) failed++;
        await ServerFirewallRule.update(r.id, {
            status: applied.ok ? "ready" : "failed",
            error: applied.ok ? "" : applied.error ?? "",
        });

        // ufw missing: no point trying the rest.
        if (!applied.ok && applied.error?.startsWith("UFW isn't installed")) break;
    }

    const sshReady = (await rulesOf(server.id)).some(
        (r) => r.type === "allow" && r.status === "ready" && r.source === "any" && coversPort(r, sshPort),
    );

    let enableError = "";
    if (sshReady) {
        const enabled = await FirewallService.enable(target);
        if (!enabled.ok) enableError = enabled.error ?? "Couldn't enable the firewall.";
    } else {
        enableError = "SSH isn't allowed yet, so the firewall was not enabled.";
    }

    return { failed, enableError };
}

export interface ResetResult {
    removed: number;
    failed: number;
    enableError: string;
}

/**
 * Puts the server back to SSH + HTTP + HTTPS only.
 *
 * Defaults are applied BEFORE anything is removed, so SSH is never uncovered
 * (the deployer opens a fresh SSH connection per command). If the defaults
 * can't be applied, nothing is removed. Only rules recorded on the Firewall
 * page are touched; rules added by hand on the machine are left alone.
 */
export async function resetFirewall(
server: { id: number; user_id: number; team_id?: number | null; port: number },    target: SshTarget,
): Promise<ResetResult> {
    const sshPort = Number(server.port);

    const defaults = [
        { name: "SSH", port: String(sshPort) },
        { name: "HTTP", port: "80" },
        { name: "HTTPS", port: "443" },
    ].map((d) => ({ ...d, type: "allow", source: "any", protocol: "tcp" }));

    const same = (
        a: { type: string; source: string; protocol: string; port: string | number },
        b: { type: string; source: string; protocol: string; port: string | number },
    ) =>
        a.type === b.type &&
        a.source === b.source &&
        a.protocol === b.protocol &&
        String(a.port) === String(b.port);

    const existing = await rulesOf(server.id);

    // 1. Defaults first. Re-applying an existing rule is harmless.
    for (const d of defaults) {
        const applied = await FirewallService.apply(target, d);
        if (!applied.ok) {
            return {
                removed: 0,
                failed: 0,
                enableError: `${applied.error ?? "Couldn't apply the default rules."} Nothing was removed.`,
            };
        }
    }

    // 2. Remove everything that isn't a default.
    let removed = 0;
    let failed = 0;
    for (const r of existing.filter((r) => !defaults.some((d) => same(d, r)))) {
        const result = await FirewallService.remove(target, r);
        if (result.ok) {
            await ServerFirewallRule.delete(r.id);
            removed++;
        } else {
            failed++;
            await ServerFirewallRule.update(r.id, { status: "failed", error: result.error ?? "" });
        }
    }

    // 3. Make sure each default has a row, and that the rows say "ready".
    for (const d of defaults) {
        const row = existing.find((r) => same(d, r));
        if (row) {
            await ServerFirewallRule.update(row.id, { status: "ready", error: "" });
        } else {
            await ServerFirewallRule.create({
    user_id: server.user_id,
    ...(server.team_id ? { team_id: Number(server.team_id) } : {}),
    server_id: server.id,
                name: d.name,
                type: d.type,
                source: d.source,
                protocol: d.protocol,
                port: d.port,
                status: "ready",
                error: "",
            });
        }
    }

    // 4. Make sure ufw is on.
    const enabled = await FirewallService.enable(target);

    return { removed, failed, enableError: enabled.ok ? "" : enabled.error ?? "Couldn't enable the firewall." };
}