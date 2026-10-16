/**
 * Feature: Provision (create a server at a cloud provider)
 *
 * A provision row tracks one "create server" request from the form until
 * the machine is online. The ProvisionServer job creates the instance and
 * advances `step`.
 *
 *   - ssh_key (encrypted private key, filled in by the job) is NEVER returned
 *   - region, plan and image are checked against the live provider catalog
 *   - someone else's provision answers 404, not 403
 *   - a provision that already has a provider instance is deleted at the
 *     provider first (through ProviderAdapter), so no billable machine is orphaned
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Provision } from "../models/Provision.js";
import { Provider } from "../models/Provider.js";
import { validateProvision, normalizeProvision } from "../validators/ProvisionValidator.js";
import { CryptoService } from "../services/CryptoService.js";
import { adapterFor } from "../services/ProviderAdapter.js";
import { Server } from "../models/Server.js";
import { dispatch } from "@tylix/core";

const TYLIX_MIN_MEMORY_MB = 4096;

const PROVIDER_NAMES: Record<string, string> = {
    linode: "Linode",
    hetzner: "Hetzner",
    digitalocean: "DigitalOcean",
};

function providerName(kind: string): string {
    return PROVIDER_NAMES[kind] ?? "the provider";
}

interface ProvisionRow {
    id: number;
    user_id: number;
    provider_id: number;
    name: string;
    region: string;
    plan: string;
    image: string;
    template: string;
    step: string;
    status: string;
    instance_id: number;
    ip: string;
    error: string;
    ssh_key: string;
    server_id: number;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

function toPublic(row: ProvisionRow) {
    const { ssh_key, root_password, ...rest } = row;
    return rest;
}

async function findOwned(req: TylixRequest, res: TylixResponse): Promise<ProvisionRow | null> {
    const row = (await Provision.find(req.params.id)) as ProvisionRow | null;

    if (!row || row.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Provision not found." });
        return null;
    }

    return row;
}

export class ProvisionController {
    async index(req: TylixRequest, res: TylixResponse) {
        const rows = (await Provision.all()) as ProvisionRow[];
        const own = rows
            .filter((p) => p.user_id === req.user?.userId && p.status !== "deleted" && p.status !== "dry_run")
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return res.json(own.map(toPublic));
    }

    async show(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;

        return res.json(toPublic(row));
    }

    async store(req: TylixRequest, res: TylixResponse) {
        const result = validateProvision(req.body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeProvision(req.body);

        const provider = (await Provider.find(input.provider_id)) as
            | { id: number; user_id: number; kind: string; api_token: string }
            | null;

        if (!provider || provider.user_id !== req.user?.userId) {
            res.status(422);
            return res.json({ errors: { provider_id: ["Choose a provider connection."] } });
        }

        const name = providerName(provider.kind);

        let adapter;
        try {
            adapter = adapterFor(provider.kind, CryptoService.decrypt(provider.api_token));
        } catch (error) {
            console.error("Provision: couldn't build the provider adapter:", error);
            res.status(422);
            return res.json({ errors: { provider_id: ["This provider connection can't be used. Edit it and paste the token again."] } });
        }

        let regions, images, plans;
        let authRejected = false;

        for (let attempt = 1; attempt <= 3 && !plans; attempt++) {
            try {
                [regions, images, plans] = await Promise.all([
                    adapter.regions(),
                    adapter.images(),
                    adapter.plans(input.region),
                ]);
            } catch (error) {
                console.error(
                    `Provision catalog check failed (${provider.kind}, attempt ${attempt}):`,
                    error instanceof Error ? error.message : error,
                );

                // A rejected token won't get better on retry.
                if (adapter.isAuthError(error)) {
                    authRejected = true;
                    break;
                }

                await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
            }
        }

        if (authRejected) {
            res.status(422);
            return res.json({
                error: `${name} rejected this connection's token. Edit the connection and paste a new one.`,
            });
        }

        if (!regions || !images || !plans) {
            res.status(502);
            return res.json({ error: `Couldn't reach ${name} to check your choices. Try again in a moment.` });
        }

        const errors: Record<string, string[]> = {};

        if (!regions.some((r) => r.id === input.region)) {
            errors.region = ["That region isn't available."];
        }
        if (!images.some((i) => i.id === input.image)) {
            errors.image = ["That operating system isn't supported."];
        }

        const plan = plans.find((p) => p.id === input.plan);
        if (!plan) {
            errors.plan = ["That plan isn't available in this region."];
        } else if (input.template === "tylix" && plan.memory_mb < TYLIX_MIN_MEMORY_MB) {
            errors.plan = ["The Tylix template needs a plan with at least 4 GB of RAM."];
        }

        if (Object.keys(errors).length > 0) {
            res.status(422);
            return res.json({ errors });
        }

        const existing = (await Provision.all()) as ProvisionRow[];
        const taken = existing.some(
            (p) => p.user_id === req.user?.userId && p.name === input.name && p.status !== "deleted",
        );
        if (taken) {
            res.status(409);
            return res.json({ error: "You already have a server with that name." });
        }

        const row = (await Provision.create({
            user_id: req.user?.userId,
            provider_id: input.provider_id,
            name: input.name,
            region: input.region,
            plan: input.plan,
            image: input.image,
            template: input.template,
            step: "queued",
            status: "pending",
            instance_id: 0,
            ip: "",
            error: "",
            ssh_key: "",
            server_id: 0,
        })) as ProvisionRow | null;

        if (!row) {
            res.status(500);
            return res.json({ error: "Could not save the request." });
        }

        try {
            await dispatch("ProvisionServer", { provisionId: row.id });
        } catch {
            await Provision.update(row.id, {
                status: "failed",
                error: "Couldn't queue the provisioning job.",
            });
        }

        res.status(201);
        return res.json(toPublic(row));
    }

    async update(_req: TylixRequest, res: TylixResponse) {
        res.status(405);
        return res.json({ error: "Provisions can't be edited." });
    }

    async destroy(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;

        if (row.status === "running") {
            res.status(409);
            return res.json({ error: "This server is still being created. Wait for it to finish or fail first." });
        }

        if (Number(row.instance_id) > 0) {
            const confirm = String(req.query?.confirm ?? "");
            if (confirm !== row.name) {
                res.status(422);
                return res.json({ error: "Type the server name to confirm." });
            }

            const provider = (await Provider.find(row.provider_id)) as
                | { user_id: number; kind: string; api_token: string }
                | null;

            if (!provider || provider.user_id !== req.user?.userId) {
                res.status(409);
                return res.json({
                    error: "The provider connection is gone, so this server has to be deleted at the provider by hand.",
                });
            }

            const name = providerName(provider.kind);

            try {
                const adapter = adapterFor(provider.kind, CryptoService.decrypt(provider.api_token));

                try {
                    // remove() already treats "already deleted" (404) as success.
                    await adapter.remove(Number(row.instance_id));
                } catch (error) {
                    console.error(
                        `Provision ${row.id}: ${provider.kind} delete failed:`,
                        error instanceof Error ? error.message : error,
                    );

                    res.status(502);
                    return res.json({
                        error: adapter.isAuthError(error)
                            ? `${name} rejected the token. Reconnect the provider, or delete the server in the ${name} dashboard.`
                            : `${name} didn't delete the server. Nothing was changed. Try again.`,
                    });
                }
            } catch (error) {
                // Couldn't even build the adapter (bad stored token, unknown kind).
                console.error(`Provision ${row.id}: couldn't prepare the ${provider.kind} delete:`, error);
                res.status(502);
                return res.json({
                    error: `Couldn't connect to ${name}. Reconnect the provider, or delete the server in the ${name} dashboard.`,
                });
            }
        }

        if (Number(row.server_id) > 0) {
            await Server.delete(row.server_id);
        }

        await Provision.update(row.id, { status: "deleted", step: "deleted", ssh_key: "", error: "" });
        res.status(204);
        return res.end();
    }
}