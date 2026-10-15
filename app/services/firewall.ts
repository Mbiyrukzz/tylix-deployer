/**
 * Server firewall routes (owner only).
 *
 * GET    /api/servers/:id/firewall            list rules
 * POST   /api/servers/:id/firewall            add a rule and apply it
 * PUT    /api/servers/:id/firewall/:ruleId    edit a rule (name-only edits don't touch the server)
 * DELETE /api/servers/:id/firewall/:ruleId    remove a rule from the server and the list
 * POST   /api/servers/:id/firewall/sync       seed defaults if empty, re-apply all, enable ufw
 *
 * Lockout guards: a deny from "any" over the SSH port is refused, and so is
 * removing or editing away the last allow rule that covers it.
 */

import type { Router } from "@tylix/core";
import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Server } from "../models/Server.js";
import { ServerFirewallRule } from "../models/ServerFirewallRule.js";
import { CryptoService } from "../services/CryptoService.js";
import { ServerLogService } from "../services/ServerLogService.js";
import { FirewallService } from "../services/FirewallService.js";
import { syncFirewall, resetFirewall } from "../services/FirewallSync.js";
import type { SshTarget } from "../services/Ssh.js";
import { validateRule, normalizeRule, parsePort } from "../validators/FirewallRuleValidator.js";

type Handler = Parameters<Router["get"]>[1];

interface ServerRow {
    id: number;
    user_id: number;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
}

interface RuleRow {
    id: number;
    user_id: number;
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

/** Server ids with a firewall change in flight, so two can't interleave. */
const working = new Set<number>();

async function findOwned(req: TylixRequest, res: TylixResponse): Promise<ServerRow | null> {
    const server = (await Server.find(req.params.id)) as ServerRow | null;

    if (!server || server.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Server not found." });
        return null;
    }
    return server;
}

function targetFor(server: ServerRow): SshTarget {
    return {
        host: server.host,
        port: Number(server.port),
        user: server.ssh_user,
        privateKey: CryptoService.decrypt(server.ssh_key),
    };
}

async function rulesOf(serverId: number): Promise<RuleRow[]> {
    const all = (await ServerFirewallRule.all()) as RuleRow[];
    return all.filter((r) => Number(r.server_id) === serverId).sort((a, b) => a.id - b.id);
}

function coversPort(rule: { protocol: string; port: string | number }, port: number): boolean {
    if (rule.protocol !== "tcp") return false;
    const range = parsePort(String(rule.port));
    return Boolean(range && port >= range.from && port <= range.to);
}

function sameSpec(
    a: { type: string; source: string; protocol: string; port: string | number },
    b: { type: string; source: string; protocol: string; port: string | number },
): boolean {
    return (
        a.type === b.type &&
        a.source === b.source &&
        a.protocol === b.protocol &&
        String(a.port) === String(b.port)
    );
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/servers/:id/firewall",
        auth(async (req, res) => {
            const server = await findOwned(req, res);
            if (!server) return;

            return res.json(await rulesOf(server.id));
        }),
    );

    router.post(
        "/api/servers/:id/firewall",
        auth(async (req, res) => {
            const server = await findOwned(req, res);
            if (!server) return;

            const result = validateRule(req.body);
            if (!result.valid) {
                res.status(422);
                return res.json({ errors: result.errors });
            }

            const input = normalizeRule(req.body);
            const existing = await rulesOf(server.id);

            if (existing.some((r) => sameSpec(r, input))) {
                res.status(409);
                return res.json({ error: "That rule already exists." });
            }

            if (input.type === "deny" && input.source === "any" && coversPort(input, Number(server.port))) {
                res.status(422);
                return res.json({
                    error: `That rule would block SSH (port ${server.port}) and lock the deployer out of this server.`,
                });
            }

            if (working.has(server.id)) {
                res.status(409);
                return res.json({ error: "Another firewall change is still running on this server." });
            }
            working.add(server.id);

            try {
                const row = (await ServerFirewallRule.create({
                    user_id: server.user_id,
                    server_id: server.id,
                    ...input,
                    status: "pending",
                    error: "",
                })) as RuleRow | null;

                if (!row) {
                    res.status(500);
                    return res.json({ error: "Could not save the rule." });
                }

                const applied = await FirewallService.apply(targetFor(server), input);

                if (!applied.ok) {
                    await ServerFirewallRule.update(row.id, { status: "failed", error: applied.error ?? "" });
                    await ServerLogService.record({
                        userId: server.user_id,
                        serverId: server.id,
                        event: "firewall.rule_failed",
                        level: "error",
                        message: `Firewall rule "${input.name}" failed: ${applied.error}`,
                    });

                    res.status(502);
                    return res.json({ error: applied.error ?? "Couldn't apply the rule." });
                }

                await ServerFirewallRule.update(row.id, { status: "ready", error: "" });
                await ServerLogService.record({
                    userId: server.user_id,
                    serverId: server.id,
                    event: "firewall.rule_added",
                    level: "success",
                    message: `Firewall rule "${input.name}" added.`,
                    meta: { type: input.type, source: input.source, protocol: input.protocol, port: input.port },
                });

                res.status(201);
                return res.json(await ServerFirewallRule.find(row.id));
            } finally {
                working.delete(server.id);
            }
        }),
    );

    router.put(
        "/api/servers/:id/firewall/:ruleId",
        auth(async (req, res) => {
            const server = await findOwned(req, res);
            if (!server) return;

            const all = await rulesOf(server.id);
            const rule = all.find((r) => r.id === Number(req.params.ruleId));

            if (!rule) {
                res.status(404);
                return res.json({ error: "Rule not found." });
            }

            const result = validateRule(req.body);
            if (!result.valid) {
                res.status(422);
                return res.json({ errors: result.errors });
            }

            const input = normalizeRule(req.body);
            const sshPort = Number(server.port);
            const others = all.filter((r) => r.id !== rule.id);

            if (others.some((r) => sameSpec(r, input))) {
                res.status(409);
                return res.json({ error: "Another rule already has those settings." });
            }

            if (input.type === "deny" && input.source === "any" && coversPort(input, sshPort)) {
                res.status(422);
                return res.json({
                    error: `That rule would block SSH (port ${sshPort}) and lock the deployer out of this server.`,
                });
            }

            // Editing away the last allow rule for SSH is the same as deleting it.
            const oldCoversSsh = rule.type === "allow" && coversPort(rule, sshPort);
            const newCoversSsh = input.type === "allow" && coversPort(input, sshPort);
            if (oldCoversSsh && !newCoversSsh) {
                const stillAllowed = others.some(
                    (r) => r.type === "allow" && r.status === "ready" && coversPort(r, sshPort),
                );
                if (!stillAllowed) {
                    res.status(422);
                    return res.json({
                        error: `This is the only rule allowing SSH (port ${sshPort}). Changing it would lock the deployer out.`,
                    });
                }
            }

            // Name only: nothing to change on the server.
            if (sameSpec(rule, input)) {
                await ServerFirewallRule.update(rule.id, { name: input.name });
                await ServerLogService.record({
                    userId: server.user_id,
                    serverId: server.id,
                    event: "firewall.rule_renamed",
                    message: `Firewall rule "${rule.name}" renamed to "${input.name}".`,
                });
                return res.json(await ServerFirewallRule.find(rule.id));
            }

            if (working.has(server.id)) {
                res.status(409);
                return res.json({ error: "Another firewall change is still running on this server." });
            }
            working.add(server.id);

            try {
                const target = targetFor(server);

                // New first, old second: if the new rule fails, the old one is untouched.
                const applied = await FirewallService.apply(target, input);
                if (!applied.ok) {
                    res.status(502);
                    return res.json({ error: applied.error ?? "Couldn't apply the new rule. Nothing was changed." });
                }

                const removed = await FirewallService.remove(target, rule);
                if (!removed.ok) {
                    // Roll the new rule back so the server matches the list again.
                    await FirewallService.remove(target, input);
                    res.status(502);
                    return res.json({ error: removed.error ?? "Couldn't replace the old rule. Nothing was changed." });
                }

                await ServerFirewallRule.update(rule.id, { ...input, status: "ready", error: "" });
                await ServerLogService.record({
                    userId: server.user_id,
                    serverId: server.id,
                    event: "firewall.rule_updated",
                    level: "success",
                    message: `Firewall rule "${input.name}" updated.`,
                    meta: {
                        from: { type: rule.type, source: rule.source, protocol: rule.protocol, port: rule.port },
                        to: { type: input.type, source: input.source, protocol: input.protocol, port: input.port },
                    },
                });

                return res.json(await ServerFirewallRule.find(rule.id));
            } finally {
                working.delete(server.id);
            }
        }),
    );

    router.delete(
        "/api/servers/:id/firewall/:ruleId",
        auth(async (req, res) => {
            const server = await findOwned(req, res);
            if (!server) return;

            const all = await rulesOf(server.id);
            const rule = all.find((r) => r.id === Number(req.params.ruleId));

            if (!rule) {
                res.status(404);
                return res.json({ error: "Rule not found." });
            }

            const sshPort = Number(server.port);
            if (rule.type === "allow" && coversPort(rule, sshPort)) {
                const others = all.filter(
                    (r) => r.id !== rule.id && r.type === "allow" && r.status === "ready" && coversPort(r, sshPort),
                );
                if (others.length === 0) {
                    res.status(422);
                    return res.json({
                        error: `This is the only rule allowing SSH (port ${sshPort}). Removing it would lock the deployer out.`,
                    });
                }
            }

            if (working.has(server.id)) {
                res.status(409);
                return res.json({ error: "Another firewall change is still running on this server." });
            }
            working.add(server.id);

            try {
                const removed = await FirewallService.remove(targetFor(server), rule);

                if (!removed.ok) {
                    res.status(502);
                    return res.json({ error: removed.error ?? "Couldn't remove the rule. Nothing was changed." });
                }

                await ServerFirewallRule.delete(rule.id);
                await ServerLogService.record({
                    userId: server.user_id,
                    serverId: server.id,
                    event: "firewall.rule_removed",
                    level: "warning",
                    message: `Firewall rule "${rule.name}" removed.`,
                });

                res.status(204);
                return res.end();
            } finally {
                working.delete(server.id);
            }
        }),
    );

    router.post(
        "/api/servers/:id/firewall/sync",
        auth(async (req, res) => {
            const server = await findOwned(req, res);
            if (!server) return;

            if (working.has(server.id)) {
                res.status(409);
                return res.json({ error: "Another firewall change is still running on this server." });
            }
            working.add(server.id);

            try {
                const { failed, enableError } = await syncFirewall(server, targetFor(server));

                await ServerLogService.record({
                    userId: server.user_id,
                    serverId: server.id,
                    event: "firewall.synced",
                    level: failed > 0 || enableError ? "warning" : "success",
                    message: enableError
                        ? `Firewall synced, but: ${enableError}`
                        : failed > 0
                          ? `Firewall synced with ${failed} failed rule${failed === 1 ? "" : "s"}.`
                          : "Firewall synced and enabled.",
                });

                if (enableError) {
                    res.status(502);
                    return res.json({ error: enableError });
                }

                return res.json(await rulesOf(server.id));
            } finally {
                working.delete(server.id);
            }
        }),
    );

        router.post(
        "/api/servers/:id/firewall/reset",
        auth(async (req, res) => {
            const server = await findOwned(req, res);
            if (!server) return;

            if (working.has(server.id)) {
                res.status(409);
                return res.json({ error: "Another firewall change is still running on this server." });
            }
            working.add(server.id);

            try {
                const { removed, failed, enableError } = await resetFirewall(server, targetFor(server));

                await ServerLogService.record({
                    userId: server.user_id,
                    serverId: server.id,
                    event: "firewall.reset",
                    level: enableError || failed > 0 ? "error" : "warning",
                    message: enableError
                        ? `Firewall reset failed: ${enableError}`
                        : failed > 0
                          ? `Firewall reset to defaults; ${removed} rule${removed === 1 ? "" : "s"} removed, ${failed} couldn't be removed.`
                          : `Firewall reset to defaults; ${removed} rule${removed === 1 ? "" : "s"} removed.`,
                    meta: { removed, failed },
                });

                if (enableError) {
                    res.status(502);
                    return res.json({ error: enableError });
                }

                return res.json({ rules: await rulesOf(server.id), removed, failed });
            } finally {
                working.delete(server.id);
            }
        }),
    );
}