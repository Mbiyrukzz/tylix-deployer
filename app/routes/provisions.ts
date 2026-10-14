/**
 * POST /api/provisions/:id/retry
 *
 * Re-queues a failed provision. The job resumes from the saved step and adopts
 * an instance it already created (tag tylix-provision-<id>), so a retry never
 * creates a second billable machine.
 */

import type { Router } from "@tylix/core";
import { dispatch } from "@tylix/core";
import { Provision } from "../models/Provision.js";
import { CryptoService } from "../services/CryptoService.js";

type Handler = Parameters<Router["post"]>[1];

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
}
