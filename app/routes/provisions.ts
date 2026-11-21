/**
 * Provision routes + server reboot.
 *
 * POST /api/provisions/:id/retry          re-queues a failed provision. The job resumes
 *                                         from the saved step and adopts an instance it
 *                                         already created (tag or label tylix-provision-<id>),
 *                                         so a retry never creates a second billable machine.
 * POST /api/provisions/:id/root-password  returns the decrypted root password. Needs a
 *                                         second-factor code in the body when the caller
 *                                         has two-factor on (requireStepUp: wrong codes are
 *                                         counted and lock the user out). POST, not GET,
 *                                         so the code never appears in a URL or access log.
 * POST /api/provisions/:id/change-password sets a new root password on a machine whose
 *                                         provider expired the old one (Hetzner), then
 *                                         re-queues the provision. Only for status
 *                                         "needs_password". Same second-factor rule as
 *                                         viewing the password. Body: { password, code? }.
 * POST /api/servers/:id/reboot            reboots a server over SSH (admin only)
 *
 * Retry and reboot answer 402 when the team's subscription has ended (view only).
 * Each of these writes an event to the server log. The root password is
 * never logged, only the fact that someone viewed it.
 *
 * Rate limits (per user, 15 minutes): 5 retries, 10 root-password requests,
 * 6 password changes, 6 reboots. They run after every cheap refusal.
 *
 * REF: nothing here reads instance_id, so the string-reference change needs no
 * edits to retry or reboot. Only the root-password wording changed.
 */

import type { Router } from "@tylix/core";
import { dispatch } from "@tylix/core";
import { Provision } from "../models/Provision.js";
import { Server } from "../models/Server.js";
import { CryptoService } from "../services/CryptoService.js";
import { changeExpiredPassword, sshExec } from "../services/Ssh.js";
import { ServerRebootService } from "../services/ServerRebootService.js";
import { ServerLogService } from "../services/ServerLogService.js";
import { createGuard, requireStepUp } from "../services/RouteGuard.js";
import { requireActive } from "../services/EntitlementService.js";

import { requireTeam, requireRole, teamIdOfRow } from "../services/TeamScope.js";
type Handler = Parameters<Router["post"]>[1];

interface RebootRow {
    id: number;
    user_id: number;
    team_id: number | null;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
}

/** Server ids with a reboot in flight, so a double click can't fire two. */
const rebooting = new Set<number>();

/** Provision ids with a password change in flight. */
const changingPassword = new Set<number>();

/**
 * Printable ASCII only: the password is typed into a remote terminal, where
 * control characters would act as keystrokes (erase, interrupt, ...).
 */
function passwordProblem(value: unknown): string | null {
    if (typeof value !== "string" || value === "") return "Enter a new password.";
    if (value.length < 12) return "Use at least 12 characters.";
    if (value.length > 128) return "Use at most 128 characters.";
    if (!/^[\x20-\x7e]+$/.test(value)) return "Use letters, numbers, spaces and symbols only (no accents or emoji).";
    if (value !== value.trim()) return "The password can't start or end with a space.";
    return null;
}

const FIFTEEN_MINUTES = 15 * 60_000;
const retryGuard = createGuard({ max: 5, windowMs: FIFTEEN_MINUTES, scope: "user", what: "retries" });
const passwordGuard = createGuard({ max: 10, windowMs: FIFTEEN_MINUTES, scope: "user", what: "root password requests" });
const changePasswordGuard = createGuard({ max: 6, windowMs: FIFTEEN_MINUTES, scope: "user", what: "password changes" });
const rebootGuard = createGuard({ max: 6, windowMs: FIFTEEN_MINUTES, scope: "user", what: "reboot requests" });

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // Admin-only: a route registered with write() answers 403 to a plain member.
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            return handler(req, res, next);
        });

    router.post(
        "/api/provisions/:id/retry",
        write(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            if (!(await requireActive(res, teamId))) return;

            const row = (await Provision.find(req.params.id)) as
                | { id: number; user_id: number; team_id?: number | null; status: string; server_id?: number }
                | null;

            if (!row || (await teamIdOfRow(row)) !== teamId) {
                res.status(404);
                return res.json({ error: "Provision not found." });
            }

            if (row.status !== "failed") {
                res.status(409);
                return res.json({ error: "Only failed servers can be retried." });
            }

            if (!retryGuard(req as any, res as any)) return;

            await Provision.update(row.id, { status: "pending", error: "" });
            await dispatch("ProvisionServer", { provisionId: row.id });

            await ServerLogService.record({
                userId: Number(req.user?.userId),
                teamId,
                provisionId: row.id,
                serverId: Number(row.server_id) || null,
                event: "provision.retried",
                message: "A failed provision was retried.",
            });

            res.status(202);
            return res.json({ ok: true });
        }),
    );

    // POST (not GET): the second-factor code travels in the body.
    router.post(
        "/api/provisions/:id/root-password",
        write(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const row = (await Provision.find(req.params.id)) as
                | { id: number; user_id: number; team_id?: number | null; server_id?: number; root_password?: string }
                | null;

            if (!row || (await teamIdOfRow(row)) !== teamId) {
                res.status(404);
                return res.json({ error: "Provision not found." });
            }

            if (!row.root_password) {
                // REF: wording changed. A missing password is normal for DigitalOcean and
                // Vultr (they never return one) and for servers created before passwords
                // were saved, so the message no longer blames one cause.
                res.status(404);
                return res.json({
                    error: "No root password is stored for this server. Some providers never issue one, and servers created before passwords were saved don't have one. Log in with the deploy key, or reset the password from your provider's dashboard.",
                });
            }

            if (!passwordGuard(req as any, res as any)) return;

            // Last gate before the secret leaves the server: second factor, if the caller
            // has one on. Runs after every check that can refuse, so a refused request
            // never spends a code. requireStepUp answers the 403/422 itself and counts
            // wrong codes.
            if (!(await requireStepUp(req as any, res as any, "view this root password"))) return;

            await ServerLogService.record({
                userId: Number(req.user?.userId),
                teamId,
                provisionId: row.id,
                serverId: Number(row.server_id) || null,
                event: "provision.root_password_viewed",
                level: "warning",
                message: "The root password was viewed.",
            });

            return res.json({ password: CryptoService.decrypt(row.root_password) });
        }),
    );

    router.post(
        "/api/provisions/:id/change-password",
        write(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            if (!(await requireActive(res, teamId))) return;

            const row = (await Provision.find(req.params.id)) as
                | {
                      id: number;
                      user_id: number;
                      team_id?: number | null;
                      status: string;
                      ip?: string;
                      ssh_key?: string;
                      root_password?: string;
                      server_id?: number;
                  }
                | null;

            if (!row || (await teamIdOfRow(row)) !== teamId) {
                res.status(404);
                return res.json({ error: "Provision not found." });
            }

            if (row.status !== "needs_password") {
                res.status(409);
                return res.json({ error: "This server isn't waiting for a password change." });
            }

            if (!row.ip || !row.ssh_key) {
                res.status(409);
                return res.json({ error: "This server isn't reachable yet. Press Retry instead." });
            }

            const password = (req.body as { password?: unknown } | undefined)?.password;
            const problem = passwordProblem(password);
            if (problem) {
                res.status(422);
                return res.json({ error: problem, errors: { password: [problem] } });
            }

            if (changingPassword.has(row.id)) {
                res.status(409);
                return res.json({ error: "A password change is already in progress." });
            }

            if (!changePasswordGuard(req as any, res as any)) return;

            // Setting the root password hands out root, same as viewing it.
            if (!(await requireStepUp(req as any, res as any, "set this server's root password"))) return;

            changingPassword.add(row.id);
            try {
                const target = {
                    host: row.ip,
                    port: 22,
                    user: "root",
                    privateKey: CryptoService.decrypt(row.ssh_key),
                };
                const current = row.root_password ? CryptoService.decrypt(row.root_password) : null;
                const next = password as string;

                const result = await changeExpiredPassword(target, current, next);

                if (!result.ok) {
                    await ServerLogService.record({
                        userId: Number(req.user?.userId),
                        teamId,
                        provisionId: row.id,
                        serverId: Number(row.server_id) || null,
                        event: "provision.root_password_change_failed",
                        level: "warning",
                        message: result.error ?? "The root password change failed.",
                    });

                    res.status(422);
                    return res.json({ error: result.error ?? "The server didn't accept that password." });
                }

                // The change is only real if the deploy key can run commands again.
                const check = await sshExec(target, "true", 20_000);
                if (check.code !== 0) {
                    res.status(502);
                    return res.json({
                        error: "The password was sent, but the server still refuses commands. Try again in a moment.",
                    });
                }

                // Someone already changed it over SSH: the stored password is stale and
                // the one typed here was never set, so store neither.
                await Provision.update(row.id, {
                    root_password: result.alreadyChanged ? "" : CryptoService.encrypt(next),
                    status: "pending",
                    error: "",
                });
                await dispatch("ProvisionServer", { provisionId: row.id });

                await ServerLogService.record({
                    userId: Number(req.user?.userId),
                    teamId,
                    provisionId: row.id,
                    serverId: Number(row.server_id) || null,
                    event: "provision.root_password_changed",
                    level: "success",
                    message: result.alreadyChanged
                        ? "The root password had already been changed on the server. Setup resumed."
                        : "A new root password was set. Setup resumed.",
                });

                res.status(202);
                return res.json({ ok: true, already_changed: Boolean(result.alreadyChanged) });
            } finally {
                changingPassword.delete(row.id);
            }
        }),
    );

    router.post(
        "/api/servers/:id/reboot",
        write(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            if (!(await requireActive(res, teamId))) return;

            const server = (await Server.find(req.params.id)) as RebootRow | null;

            if (!server || Number(server.team_id) !== teamId) {
                res.status(404);
                return res.json({ error: "Server not found." });
            }

            if (!rebootGuard(req as any, res as any)) return;

            if (rebooting.has(server.id)) {
                await ServerLogService.record({
                    userId: Number(req.user?.userId),
                    teamId,
                    serverId: server.id,
                    event: "server.reboot.blocked",
                    level: "warning",
                    message: "Reboot refused: one is already in progress.",
                });

                res.status(409);
                return res.json({ error: "A reboot is already in progress for this server." });
            }

            rebooting.add(server.id);
            // Hold the guard a little after the command succeeds, covering the shutdown window.
            let hold = 0;

            try {
                await ServerLogService.record({
                    userId: Number(req.user?.userId),
                    teamId,
                    serverId: server.id,
                    event: "server.reboot.requested",
                    message: "Reboot requested.",
                });

                const result = await ServerRebootService.reboot({
                    host: server.host,
                    port: Number(server.port),
                    ssh_user: server.ssh_user,
                    ssh_key: server.ssh_key,
                });

                if (!result.ok) {
                    await ServerLogService.record({
                        userId: Number(req.user?.userId),
                        teamId,
                        serverId: server.id,
                        event: "server.reboot.failed",
                        level: "error",
                        message: result.error ?? "The reboot command failed.",
                    });

                    res.status(502);
                    return res.json({ error: result.error ?? "The reboot command failed." });
                }

                await ServerLogService.record({
                    userId: Number(req.user?.userId),
                    teamId,
                    serverId: server.id,
                    event: "server.reboot.sent",
                    level: "success",
                    message: "Reboot command accepted by the server.",
                });

                hold = 60_000;
                res.status(202);
                return res.json({ ok: true });
            } finally {
                setTimeout(() => rebooting.delete(server.id), hold);
            }
        }),
    );
}