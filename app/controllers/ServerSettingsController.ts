/**
 * Feature: Server settings (team-scoped)
 *
 * A server on another team answers 404, never 403. Any member can read the
 * settings, live system details and the delete check; every change needs the
 * admin role and an active (not view-only) team.
 *
 *   GET  /api/servers/:id/settings                    details, key state, host key state, provision info
 *   GET  /api/servers/:id/system                      live over SSH: system details + services
 *   GET  /api/servers/:id/delete-check                what blocks deleting this server
 *   POST /api/servers/:id/key/reveal        { code? } the key fingerprints (hidden by default)
 *   POST /api/servers/:id/test                        try to log in, save status
 *   POST /api/servers/:id/key/rotate        { code? }
 *   POST /api/servers/:id/host-key/pin      { code?, replace? }
 *   PUT  /api/servers/:id/system/timezone   { timezone }
 *   PUT  /api/servers/:id/system/hostname   { hostname }
 *   PUT  /api/servers/:id/system/updates    { enabled }
 *   POST /api/servers/:id/services/:service/restart
 *   POST /api/servers/:id/reboot            { code? }
 *
 * Fingerprints are never part of /settings. Viewing them goes through
 * /key/reveal, which needs a valid two-factor code when the caller has
 * two-factor on (requireStepUp), and is written to the server log.
 *
 * Rotating the key, rebooting and replacing a pinned host key also need a
 * valid two-factor code when the caller has two-factor on (requireStepUp).
 * That check runs last, after every check that can refuse the request, so a
 * refused request never spends a code. The first pin of a host key needs no
 * code: it is the same trust the deployer already extends today.
 *
 * Every change and every failure is written to the server log, with the
 * reason. Keys and fingerprints are never logged. Editing the connection
 * details and deleting the server stay on the existing ServerController
 * endpoints.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Server } from "../models/Server.js";
import { Site } from "../models/Site.js";
import { Provision } from "../models/Provision.js";
import { Provider } from "../models/Provider.js";
import {
    ServerSystem,
    SystemError,
    TIMEZONE,
    HOSTNAME,
    isRestartable,
    type SystemServer,
} from "../services/ServerSystem.js";
import { ServerLogService } from "../services/ServerLogService.js";
import { createGuard, requireStepUp } from "../services/RouteGuard.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { requireActive } from "../services/EntitlementService.js";
import { sshExec, hostKeyFingerprint, HOST_KEY_RE } from "../services/Ssh.js";
import { serverTarget } from "../services/Shell.js";

interface ServerRow extends SystemServer {
    user_id: number;
    team_id: number | null;
    status: string;
    created_at: string;
    updated_at: string;
    last_checked_at?: string;
    last_error?: string;
    key_rotated_at?: string;
    ssh_host_key?: string | null;
    ssh_host_key_at?: string | null;
}

interface ProvisionRow {
    id: number;
    server_id: number;
    provider_id: number;
    status: string;
    region: string;
    plan: string;
    image: string;
    template: string;
    ip: string;
    [key: string]: unknown;
}

const readGuard = createGuard({ max: 60, windowMs: 60_000, scope: "user", what: "server detail requests" });
const actionGuard = createGuard({ max: 20, windowMs: 10 * 60_000, scope: "user", what: "server changes" });

async function findOwned(req: TylixRequest, res: TylixResponse): Promise<ServerRow | null> {
    const teamId = requireTeam(req, res);
    if (!teamId) return null;

    const server = (await Server.find(req.params.id)) as ServerRow | null;

    if (!server || Number(server.team_id) !== teamId) {
        res.status(404);
        res.json({ error: "Server not found." });
        return null;
    }

    return server;
}

/** Admin + active team, in the order the other controllers use. Returns the server or null (already answered). */
async function findForChange(req: TylixRequest, res: TylixResponse): Promise<ServerRow | null> {
    const server = await findOwned(req, res);
    if (!server) return null;
    if (!requireRole(req, res, "admin")) return null;
    if (!(await requireActive(res, Number(req.user?.teamId)))) return null;
    if (!actionGuard(req, res)) return null;
    return server;
}

/** Writes to the server log. Never throws. */
async function note(
    req: TylixRequest,
    server: ServerRow,
    event: string,
    message: string,
    level: "info" | "success" | "warning" | "error" = "info",
    meta: Record<string, unknown> = {},
): Promise<void> {
    try {
        await ServerLogService.record({
            userId: Number(req.user?.userId),
            teamId: Number(server.team_id),
            serverId: server.id,
            event,
            level,
            message,
            meta,
        });
    } catch (err) {
        console.error(`Couldn't write the server log entry for server ${server.id}:`, err);
    }
}

function answerError(res: TylixResponse, err: unknown, fallback: string) {
    if (err instanceof SystemError) {
        res.status(err.status);
        return res.json({ error: err.message });
    }

    res.status(502);
    return res.json({ error: err instanceof Error ? err.message : fallback });
}

/** Runs one change under the per-server lock, logs the outcome and answers. */
async function perform(
    req: TylixRequest,
    res: TylixResponse,
    server: ServerRow,
    event: string,
    what: string,
    run: () => Promise<string>,
    meta: Record<string, unknown> = {},
) {
    try {
        const message = await ServerSystem.locked(server.id, run);
        await note(req, server, `server.${event}`, message, "success", meta);
        return res.json({ ok: true, message });
    } catch (err) {
        const reason = err instanceof Error ? err.message : "Unknown error.";
        await note(req, server, `server.${event}_failed`, `${what} failed: ${reason}`.slice(0, 600), "error", meta);
        return answerError(res, err, `${what} failed.`);
    }
}

function publicServer(row: ServerRow) {
    const { ssh_key, ...rest } = row;
    return { ...rest, has_ssh_key: Boolean(ssh_key) };
}

async function provisionOf(serverId: number): Promise<ProvisionRow | null> {
    const rows = (await Provision.all()) as ProvisionRow[];
    return rows.find((p) => Number(p.server_id) === serverId && p.status !== "deleted") ?? null;
}

/** What the settings page shows about the pinned host key. The fingerprint is not included: see revealKey. */
function hostKeyInfo(server: ServerRow) {
    const pinned = Boolean(server.ssh_host_key);

    return {
        pinned,
        type: server.ssh_host_key?.split(" ")[0] ?? "",
        pinned_at: String(server.ssh_host_key_at ?? ""),
        // Set only for a pinned server whose last connection failed on the key check.
        changed: pinned && /host key verification failed|host identification has changed/i.test(String(server.last_error ?? "")),
    };
}

export class ServerSettingsController {
    /** GET /api/servers/:id/settings */
    async show(req: TylixRequest, res: TylixResponse) {
        const server = await findOwned(req, res);
        if (!server) return;
        if (!readGuard(req, res)) return;

        const prov = await provisionOf(server.id);
        let provider = "";

        if (prov) {
            const row = (await Provider.find(prov.provider_id)) as { kind: string } | null;
            provider = String(row?.kind ?? "");
        }

        // Only whether the key can be read. The fingerprint itself comes from /key/reveal.
        const fingerprint = await ServerSystem.fingerprint(server);

        return res.json({
            server: publicServer(server),
            key: {
                readable: Boolean(fingerprint),
                rotated_at: String(server.key_rotated_at ?? ""),
            },
            host_key: hostKeyInfo(server),
            provision: prov
                ? { provider, region: prov.region, plan: prov.plan, image: prov.image, template: prov.template, ip: prov.ip }
                : null,
        });
    }

    /**
     * POST /api/servers/:id/key/reveal   body { code? }
     *
     * The deploy key and pinned host key fingerprints. Any member may ask, but
     * with two-factor on a valid code is required. Every view is logged.
     */
    async revealKey(req: TylixRequest, res: TylixResponse) {
        const server = await findOwned(req, res);
        if (!server) return;
        if (!actionGuard(req, res)) return;

        // Last gate before the answer: second factor, if the caller has one on.
        if (!(await requireStepUp(req, res, "view this server's key fingerprints"))) return;

        await note(req, server, "server.fingerprints_viewed", `The key fingerprints for "${server.name}" were viewed.`, "info");

        return res.json({
            fingerprint: await ServerSystem.fingerprint(server),
            host_fingerprint: server.ssh_host_key ? hostKeyFingerprint(server.ssh_host_key) : "",
        });
    }

    /** GET /api/servers/:id/system: live over SSH. */
    async system(req: TylixRequest, res: TylixResponse) {
        const server = await findOwned(req, res);
        if (!server) return;
        if (!readGuard(req, res)) return;

        try {
            return res.json(await ServerSystem.inspect(server));
        } catch (err) {
            return answerError(res, err, "Couldn't read the server's details.");
        }
    }

    /** GET /api/servers/:id/delete-check */
    async deleteCheck(req: TylixRequest, res: TylixResponse) {
        const server = await findOwned(req, res);
        if (!server) return;
        if (!readGuard(req, res)) return;

        const blockers: { code: string; message: string; sites?: { id: number; domain: string }[] }[] = [];

        const prov = await provisionOf(server.id);
        if (prov) {
            blockers.push({
                code: "provisioned",
                message:
                    "This server was created by the deployer. Delete it from the Provisioned servers list so it is removed at your cloud provider too.",
            });
        }

        const sites = ((await Site.all()) as { id: number; server_id: number; domain: string }[]).filter(
            (s) => Number(s.server_id) === server.id,
        );
        if (sites.length > 0) {
            blockers.push({
                code: "sites",
                message:
                    sites.length === 1
                        ? "This server still has 1 site. Delete it first."
                        : `This server still has ${sites.length} sites. Delete them first.`,
                sites: sites.slice(0, 10).map((s) => ({ id: s.id, domain: s.domain })),
            });
        }

        return res.json({ can_delete: blockers.length === 0, provisioned: Boolean(prov), blockers });
    }

    /** POST /api/servers/:id/test */
    async test(req: TylixRequest, res: TylixResponse) {
        const server = await findForChange(req, res);
        if (!server) return;

        const result = await ServerSystem.check(server);

        await note(
            req,
            server,
            result.ok ? "server.connection_ok" : "server.connection_failed",
            result.ok ? `Connection to "${server.name}" succeeded.` : `Connection to "${server.name}" failed: ${result.error}`,
            result.ok ? "success" : "warning",
            { host: server.host, port: Number(server.port) },
        );

        return res.json(result);
    }

    /** POST /api/servers/:id/key/rotate   body { code? } */
    async rotateKey(req: TylixRequest, res: TylixResponse) {
        const server = await findForChange(req, res);
        if (!server) return;

        if (ServerSystem.isBusy(server.id)) {
            res.status(409);
            return res.json({ error: "Another change is still running on this server. Try again in a moment." });
        }

        // Last gate before the change: second factor, if the caller has one on.
        if (!(await requireStepUp(req, res, "replace this server's SSH key"))) return;

        try {
            const result = await ServerSystem.locked(server.id, () => ServerSystem.rotateKey(server));

            await note(
                req,
                server,
                "server.key_rotated",
                `The deploy key for "${server.name}" was replaced.`,
                result.warning ? "warning" : "success",
                { warning: result.warning || null },
            );

            return res.json({
                ok: true,
                rotated_at: result.rotated_at,
                warning: result.warning,
            });
        } catch (err) {
            const reason = err instanceof Error ? err.message : "Unknown error.";
            await note(req, server, "server.key_rotation_failed", `Replacing the deploy key failed: ${reason}`.slice(0, 600), "error");
            return answerError(res, err, "Couldn't replace the key.");
        }
    }

    /**
     * POST /api/servers/:id/host-key/pin   body { code?, replace? }
     *
     * Connects without a pin, so the key is read from the same session that
     * authenticates, then stores it. Replacing an existing pin needs the
     * second factor; the first pin does not.
     */
    async pinHostKey(req: TylixRequest, res: TylixResponse) {
        const server = await findForChange(req, res);
        if (!server) return;

        const replace = ((req.body ?? {}) as Record<string, unknown>).replace === true;

        if (server.ssh_host_key && !replace) {
            res.status(409);
            return res.json({ error: "A host key is already pinned. Use Trust new key to replace it." });
        }

        if (ServerSystem.isBusy(server.id)) {
            res.status(409);
            return res.json({ error: "Another change is still running on this server. Try again in a moment." });
        }

        // Replacing a pin is the dangerous case, so it needs the second factor. Last gate.
        if (replace && !(await requireStepUp(req, res, "trust a new host key for this server"))) return;

        const result = await sshExec(serverTarget({ ...server, ssh_host_key: null } as never), "true", 15_000);
        const seen = result.code === 0 ? result.observedHostKey : null;

        if (!seen || !HOST_KEY_RE.test(seen)) {
            await note(req, server, "server.host_key_pin_failed", "Couldn't read the host key.", "error");
            res.status(502);
            return res.json({ error: "Couldn't connect to read the host key. Press Test connection first." });
        }

        await Server.update(server.id, { ssh_host_key: seen, ssh_host_key_at: new Date().toISOString() });

        await note(
            req,
            server,
            replace ? "server.host_key_replaced" : "server.host_key_pinned",
            `Host key ${replace ? "replaced" : "pinned"} for "${server.name}".`,
            replace ? "warning" : "success",
        );

        return res.json({ ok: true });
    }

    /** PUT /api/servers/:id/system/timezone   body { timezone } */
    async timezone(req: TylixRequest, res: TylixResponse) {
        const server = await findForChange(req, res);
        if (!server) return;

        const zone = String(((req.body ?? {}) as Record<string, unknown>).timezone ?? "").trim();

        if (!TIMEZONE.test(zone) || zone.includes("..")) {
            res.status(422);
            return res.json({ error: "Use a timezone name like Africa/Nairobi or UTC." });
        }

        return perform(req, res, server, "timezone_changed", "Changing the timezone", () => ServerSystem.setTimezone(server, zone), { timezone: zone });
    }

    /** PUT /api/servers/:id/system/hostname   body { hostname } */
    async hostname(req: TylixRequest, res: TylixResponse) {
        const server = await findForChange(req, res);
        if (!server) return;

        const name = String(((req.body ?? {}) as Record<string, unknown>).hostname ?? "").trim().toLowerCase();

        if (!HOSTNAME.test(name)) {
            res.status(422);
            return res.json({ error: "Use 1 to 63 lowercase letters, digits or hyphens, not starting or ending with a hyphen." });
        }

        return perform(req, res, server, "hostname_changed", "Changing the hostname", () => ServerSystem.setHostname(server, name), { hostname: name });
    }

    /** PUT /api/servers/:id/system/updates   body { enabled } */
    async updates(req: TylixRequest, res: TylixResponse) {
        const server = await findForChange(req, res);
        if (!server) return;

        const enabled = ((req.body ?? {}) as Record<string, unknown>).enabled;

        if (typeof enabled !== "boolean") {
            res.status(422);
            return res.json({ error: "Say whether automatic updates should be on or off." });
        }

        return perform(req, res, server, "auto_updates_changed", "Changing automatic updates", () => ServerSystem.setAutoUpdates(server, enabled), { enabled });
    }

    /** POST /api/servers/:id/services/:service/restart */
    async restart(req: TylixRequest, res: TylixResponse) {
        const server = await findForChange(req, res);
        if (!server) return;

        const service = String(req.params.service ?? "");

        if (!isRestartable(service)) {
            res.status(422);
            return res.json({ error: "That service can't be restarted from here." });
        }

        return perform(req, res, server, "service_restarted", `Restarting ${service}`, () => ServerSystem.restartService(server, service), { service });
    }

    /** POST /api/servers/:id/reboot   body { code? } */
    async reboot(req: TylixRequest, res: TylixResponse) {
        const server = await findForChange(req, res);
        if (!server) return;

        if (ServerSystem.isBusy(server.id)) {
            res.status(409);
            return res.json({ error: "Another change is still running on this server. Try again in a moment." });
        }

        // Last gate before the change: second factor, if the caller has one on.
        if (!(await requireStepUp(req, res, "reboot this server"))) return;

        return perform(req, res, server, "reboot_scheduled", "Scheduling the reboot", () => ServerSystem.reboot(server));
    }
}