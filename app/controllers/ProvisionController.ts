/**
 * Feature: Provision (create a server at a cloud provider)
 *
 * A provision row tracks one "create server" request from the form until
 * the machine is online. The ProvisionServer job creates the instance and
 * advances `step`.
 *
 *   - team-scoped: any member can list and view provisions; creating and
 *     deleting one (it costs money) needs the admin role
 *   - creating one is checked against the team's server limit. Machines that
 *     are still being created count too, so two quick requests can't both
 *     slip under the limit
 *   - ssh_key (encrypted private key, filled in by the job) is NEVER returned
 *   - region, plan and image are checked against the live provider catalog
 *   - another team's provision answers 404, not 403 (checked before the role)
 *   - a provision that already has a provider instance is deleted at the
 *     provider first (through ProviderAdapter), so no billable machine is orphaned
 *   - deleting also removes the server's records (ServerRecords), and is
 *     refused while the server still has sites
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Provision } from "../models/Provision.js";
import { Provider } from "../models/Provider.js";
import { validateProvision, normalizeProvision } from "../validators/ProvisionValidator.js";
import { requireTeam, requireRole, teamIdOfRow } from "../services/TeamScope.js";
import { requireWithin, requireActive } from "../services/EntitlementService.js";
import { adapterFor, instanceRefOf, providerName, providerSecret } from "../services/ProviderAdapter.js";
import { ServerRecords } from "../services/ServerRecords.js";
import { dispatch } from "@tylix/core";

const TYLIX_MIN_MEMORY_MB = 4096;

interface ProvisionRow {
    id: number;
    user_id: number;
    provider_id: number;
    team_id: number | null;
    name: string;
    region: string;
    plan: string;
    image: string;
    template: string;
    step: string;
    status: string;
    instance_id: number;
    instance_ref: string;
    ip: string;
    error: string;
    ssh_key: string;
    server_id: number;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

// The UI gets has_instance (any provider id) and has_root_password (so it can hide
// the button on providers that never issue one). The password itself is never returned.
function toPublic(row: ProvisionRow) {
    const { ssh_key, root_password, ...rest } = row;
    return {
        ...rest,
        has_instance: instanceRefOf(row) !== "",
        has_root_password: Boolean(root_password),
    };
}

/** Loads a provision and answers 404 itself if it is missing or not on the caller's team. */
async function findOwned(req: TylixRequest, res: TylixResponse): Promise<ProvisionRow | null> {
    const teamId = requireTeam(req, res);
    if (!teamId) return null;

    const row = (await Provision.find(req.params.id)) as ProvisionRow | null;

    // teamIdOfRow also covers older rows that were never stamped.
    if (!row || (await teamIdOfRow(row)) !== teamId) {
        res.status(404);
        res.json({ error: "Provision not found." });
        return null;
    }

    return row;
}

export class ProvisionController {
    /** Any team member. */
    async index(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;

        const rows = (await Provision.all()) as ProvisionRow[];
        const own = rows
            .filter((p) => Number(p.team_id) === teamId && p.status !== "deleted" && p.status !== "dry_run")
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return res.json(own.map(toPublic));
    }

    /** Any team member. */
    async show(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;

        return res.json(toPublic(row));
    }

    /** Admin only: this creates a billable machine at the provider. Limited by the team's plan. */
    async store(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, teamId))) return;

        const result = validateProvision(req.body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeProvision(req.body);

        const provider = (await Provider.find(input.provider_id)) as
            | { id: number; user_id: number; team_id: number | null; kind: string; api_token: string; credentials: string }
            | null;

        if (!provider || (await teamIdOfRow(provider)) !== teamId) {
            res.status(422);
            return res.json({ errors: { provider_id: ["Choose a provider connection."] } });
        }

        const existing = (await Provision.all()) as ProvisionRow[];

        // A machine still being created isn't a server yet, but it will be, so it
        // counts now. Checked before the catalog calls so a team over its limit
        // doesn't wait on the provider's API.
        const inFlight = existing.filter(
            (p) =>
                Number(p.team_id) === teamId &&
                (p.status === "pending" || p.status === "running") &&
                !Number(p.server_id),
        ).length;

        if (!(await requireWithin(res, teamId, "servers", 1 + inFlight))) return;

        const name = providerName(provider.kind);

        let adapter;
        try {
            adapter = adapterFor(provider.kind, providerSecret(provider));
        } catch (error) {
            console.error("Provision: couldn't build the provider adapter:", error);
            res.status(422);
            return res.json({ errors: { provider_id: ["This provider connection can't be used. Edit it and paste the credentials again."] } });
        }

        const MAX_ATTEMPTS = 3;
        let regions, images, plans;
        let authRejected = false;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !plans; attempt++) {
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

                // Rejected credentials won't get better on retry.
                if (adapter.isAuthError(error)) {
                    authRejected = true;
                    break;
                }

                // No point waiting after the last attempt.
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
                }
            }
        }

        if (authRejected) {
            res.status(422);
            return res.json({
                error: `${name} rejected this connection's credentials. Edit the connection and paste new ones.`,
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

        const taken = existing.some(
            (p) => Number(p.team_id) === teamId && p.name === input.name && p.status !== "deleted",
        );
        if (taken) {
            res.status(409);
            return res.json({ error: "Your team already has a server with that name." });
        }

        const row = (await Provision.create({
            user_id: req.user?.userId,
            team_id: teamId,
            provider_id: input.provider_id,
            name: input.name,
            region: input.region,
            plan: input.plan,
            image: input.image,
            template: input.template,
            step: "queued",
            status: "pending",
            instance_id: 0,
            instance_ref: "", // empty until the provider accepts the create call
            ip: "",
            error: "",
            ssh_key: "",
            server_id: 0,
        })) as ProvisionRow | null;

        if (!row) {
            res.status(500);
            return res.json({ error: "Could not save the request." });
        }

        let current: ProvisionRow = row;

        try {
            await dispatch("ProvisionServer", { provisionId: row.id });
        } catch {
            await Provision.update(row.id, {
                status: "failed",
                error: "Couldn't queue the provisioning job.",
            });
            // Answer with the row as it is now, not the stale "pending" copy.
            current = ((await Provision.find(row.id)) as ProvisionRow | null) ?? {
                ...row,
                status: "failed",
                error: "Couldn't queue the provisioning job.",
            };
        }

        res.status(201);
        return res.json(toPublic(current));
    }

    async update(_req: TylixRequest, res: TylixResponse) {
        res.status(405);
        return res.json({ error: "Provisions can't be edited." });
    }

    /** Admin only. Another team's provision answers 404 before the role is checked. */
    async destroy(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;

        if (row.status === "running") {
            res.status(409);
            return res.json({ error: "This server is still being created. Wait for it to finish or fail first." });
        }

        // Checked before touching the provider, so we never destroy the machine
        // and then refuse because sites still point at it.
        const serverId = Number(row.server_id);
        if (serverId > 0) {
            const sites = await ServerRecords.siteCount(serverId);
            if (sites > 0) {
                res.status(409);
                return res.json({
                    error:
                        sites === 1
                            ? "This server still has 1 site. Delete it first, then delete the server."
                            : `This server still has ${sites} sites. Delete them first, then delete the server.`,
                });
            }
        }

        const ref = instanceRefOf(row);

        if (ref) {
            const confirm = String(req.query?.confirm ?? "");
            if (confirm !== row.name) {
                res.status(422);
                return res.json({ error: "Type the server name to confirm." });
            }

            const provider = (await Provider.find(row.provider_id)) as
                | { user_id: number; team_id?: number | null; kind: string; api_token: string; credentials: string }
                | null;

            if (!provider || (await teamIdOfRow(provider)) !== (await teamIdOfRow(row))) {
                res.status(409);
                return res.json({
                    error: "The provider connection is gone, so this server has to be deleted at the provider by hand.",
                });
            }

            const name = providerName(provider.kind);

            try {
                const adapter = adapterFor(provider.kind, providerSecret(provider));

                try {
                    // remove() already treats "already deleted" (404) as success.
                    await adapter.remove(ref);
                } catch (error) {
                    console.error(
                        `Provision ${row.id}: ${provider.kind} delete failed:`,
                        error instanceof Error ? error.message : error,
                    );

                    res.status(502);
                    return res.json({
                        error: adapter.isAuthError(error)
                            ? `${name} rejected the credentials. Reconnect the provider, or delete the server in the ${name} dashboard.`
                            : `${name} didn't delete the server. Nothing was changed. Try again.`,
                    });
                }
            } catch (error) {
                // Couldn't even build the adapter (bad stored credentials, unknown kind).
                console.error(`Provision ${row.id}: couldn't prepare the ${provider.kind} delete:`, error);
                res.status(502);
                return res.json({
                    error: `Couldn't connect to ${name}. Reconnect the provider, or delete the server in the ${name} dashboard.`,
                });
            }
        }

        if (serverId > 0) {
            await ServerRecords.removeAll(serverId);
        }

        await Provision.update(row.id, { status: "deleted", step: "deleted", ssh_key: "", error: "" });
        res.status(204);
        return res.end();
    }
}