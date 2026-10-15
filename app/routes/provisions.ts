/**
 * Provision routes + server reboot.
 *
 * POST /api/provisions/:id/retry          re-queues a failed provision. The job resumes
 *                                         from the saved step and adopts an instance it
 *                                         already created (tag tylix-provision-<id>), so
 *                                         a retry never creates a second billable machine.
 * GET  /api/provisions/:id/root-password  returns the decrypted root password
 * POST /api/servers/:id/reboot            reboots a server over SSH (owner only)
 *
 * Each of these writes an event to the server log. The root password is
 * never logged, only the fact that someone viewed it.
 */

import type { Router } from "@tylix/core";
import { dispatch } from "@tylix/core";
import { Provision } from "../models/Provision.js";
import { Server } from "../models/Server.js";
import { CryptoService } from "../services/CryptoService.js";
import { ServerRebootService } from "../services/ServerRebootService.js";
import { ServerLogService } from "../services/ServerLogService.js";

type Handler = Parameters<Router["post"]>[1];

interface RebootRow {
    id: number;
    user_id: number;
    host: string;
    port: number;
    ssh_user: string;
    ssh_key: string;
}

/** Server ids with a reboot in flight, so a double click can't fire two. */
const rebooting = new Set<number>();

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.post(
        "/api/provisions/:id/retry",
        auth(async (req, res) => {
            const row = (await Provision.find(req.params.id)) as
                | { id: number; user_id: number; status: string; server_id?: number }
                | null;

            if (!row || row.user_id !== req.user?.userId) {
                res.status(404);
                return res.json({ error: "Provision not found." });
            }

            if (row.status !== "failed") {
                res.status(409);
                return res.json({ error: "Only failed servers can be retried." });
            }

            await Provision.update(row.id, { status: "pending", error: "" });
            await dispatch("ProvisionServer", { provisionId: row.id });

            await ServerLogService.record({
                userId: row.user_id,
                provisionId: row.id,
                serverId: Number(row.server_id) || null,
                event: "provision.retried",
                message: "A failed provision was retried.",
            });

            res.status(202);
            return res.json({ ok: true });
        }),
    );

    router.get(
        "/api/provisions/:id/root-password",
        auth(async (req, res) => {
            const row = (await Provision.find(req.params.id)) as
                | { id: number; user_id: number; server_id?: number; root_password?: string }
                | null;

            if (!row || row.user_id !== req.user?.userId) {
                res.status(404);
                return res.json({ error: "Provision not found." });
            }

            if (!row.root_password) {
                res.status(404);
                return res.json({
                    error: "No root password is stored for this server. It was created before passwords were saved. Reset it from your provider's dashboard instead.",
                });
            }

            await ServerLogService.record({
                userId: row.user_id,
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
        "/api/servers/:id/reboot",
        auth(async (req, res) => {
            const server = (await Server.find(req.params.id)) as RebootRow | null;

            if (!server || server.user_id !== req.user?.userId) {
                res.status(404);
                return res.json({ error: "Server not found." });
            }

            if (rebooting.has(server.id)) {
                await ServerLogService.record({
                    userId: server.user_id,
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
                    userId: server.user_id,
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
                        userId: server.user_id,
                        serverId: server.id,
                        event: "server.reboot.failed",
                        level: "error",
                        message: result.error ?? "The reboot command failed.",
                    });

                    res.status(502);
                    return res.json({ error: result.error ?? "The reboot command failed." });
                }

                await ServerLogService.record({
                    userId: server.user_id,
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