/**
 * Provision routes + server reboot.
 *
 * POST /api/provisions/:id/retry          re-queues a failed provision. The job resumes
 *                                         from the saved step and adopts an instance it
 *                                         already created (tag tylix-provision-<id>), so
 *                                         a retry never creates a second billable machine.
 * GET  /api/provisions/:id/root-password  returns the decrypted root password
 * POST /api/servers/:id/reboot            reboots a server over SSH (owner only)
 */

import type { Router } from "@tylix/core";
import { dispatch } from "@tylix/core";
import { Provision } from "../models/Provision.js";
import { Server } from "../models/Server.js";
import { CryptoService } from "../services/CryptoService.js";
import { ServerRebootService } from "../services/ServerRebootService.js";

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
                | { id: number; user_id: number; status: string }
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

            res.status(202);
            return res.json({ ok: true });
        }),
    );

    router.get(
        "/api/provisions/:id/root-password",
        auth(async (req, res) => {
            const row = (await Provision.find(req.params.id)) as
                | { id: number; user_id: number; root_password?: string }
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
                res.status(409);
                return res.json({ error: "A reboot is already in progress for this server." });
            }

            rebooting.add(server.id);
            // Hold the guard a little after the command succeeds, covering the shutdown window.
            let hold = 0;

            try {
                const result = await ServerRebootService.reboot({
                    host: server.host,
                    port: Number(server.port),
                    ssh_user: server.ssh_user,
                    ssh_key: server.ssh_key,
                });

                if (!result.ok) {
                    res.status(502);
                    return res.json({ error: result.error ?? "The reboot command failed." });
                }

                hold = 60_000;
                res.status(202);
                return res.json({ ok: true });
            } finally {
                setTimeout(() => rebooting.delete(server.id), hold);
            }
        }),
    );
}