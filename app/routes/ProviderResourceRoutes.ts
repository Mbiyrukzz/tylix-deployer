/**
 * Provider resource routes: machines, firewalls, volumes, images, IPs.
 *
 * GET    /api/providers/:id/machines
 * POST   /api/providers/:id/machines/:machineId/:action      boot | shutdown | reboot
 *
 * GET    /api/providers/:id/firewalls
 * POST   /api/providers/:id/firewalls                        { label }
 * PUT    /api/providers/:id/firewalls/:firewallId/rules      { rules, inbound_policy, outbound_policy }
 * DELETE /api/providers/:id/firewalls/:firewallId
 *
 * GET    /api/providers/:id/volumes
 * POST   /api/providers/:id/volumes                          { label, size, region | machine_id }
 * POST   /api/providers/:id/volumes/:volumeId/attach         { machine_id }
 * POST   /api/providers/:id/volumes/:volumeId/detach
 * DELETE /api/providers/:id/volumes/:volumeId
 *
 * GET    /api/providers/:id/images
 * POST   /api/providers/:id/images                           { machine_id, label }
 * PUT    /api/providers/:id/images/:imageId                  { label }
 * DELETE /api/providers/:id/images/:imageId
 *
 * GET    /api/providers/:id/ips
 * POST   /api/providers/:id/ips                              { version, region | machine_id, label }
 * PUT    /api/providers/:id/ips/:ipId                        { rdns }
 * DELETE /api/providers/:id/ips/:ipId
 *
 * Same rules as the domains routes: the connection must be the caller's (404
 * otherwise), credentials are decrypted here and never returned, and a token
 * that lacks access answers 403 with code "missing_access".
 */

import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { Provider } from "../models/Provider.js";
import { providerName, providerSecret } from "../services/ProviderAdapter.js";
import { ManageError } from "../services/ProviderManage.js";
import {
    resourcesFor,
    RESOURCE_KINDS,
    RESOURCE_ACCESS_HELP,
    type ResourceAdapter,
    type MachineAction,
} from "../services/ProviderResources.js";
import {
    validateMachineAction,
    validateFirewallCreate,
    normalizeFirewallCreate,
    validateFirewallRules,
    normalizeFirewallRules,
    validateVolumeCreate,
    normalizeVolumeCreate,
    validateMachineRef,
    normalizeMachineRef,
    validateImageCreate,
    normalizeImageCreate,
    validateImageRename,
    normalizeImageRename,
    validateIpAllocate,
    normalizeIpAllocate,
    validateRdns,
    normalizeRdns,
} from "../validators/ResourceValidator.js";

type Handler = Parameters<Router["get"]>[1];

interface ProviderRow {
    id: number;
    user_id: number;
    kind: string;
    api_token: string;
    credentials: string;
}

/** Loads the caller's connection, builds the adapter, runs the job and maps every failure. */
async function run(
    req: TylixRequest,
    res: TylixResponse,
    job: (adapter: ResourceAdapter, kind: string) => Promise<unknown>,
    success = 200,
): Promise<void> {
    const row = (await Provider.find(req.params.id)) as ProviderRow | null;

    if (!row || row.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Provider connection not found." });
        return;
    }

    const name = providerName(row.kind);

    if (!RESOURCE_KINDS.includes(row.kind)) {
        res.status(422);
        res.json({ error: `This section isn't available for ${name} yet.`, code: "unsupported" });
        return;
    }

    let adapter: ResourceAdapter;
    try {
        adapter = resourcesFor(row.kind, providerSecret(row));
    } catch (error) {
        console.error(`[provider-resources] couldn't build the ${row.kind} adapter:`, error);
        res.status(422);
        res.json({ error: `This ${name} connection can't be used. Edit it and paste the credentials again.` });
        return;
    }

    try {
        const result = await job(adapter, row.kind);

        if (success === 204) {
            res.status(204);
            res.end();
            return;
        }

        res.status(success);
        res.json(result);
        return;
    } catch (error) {
        if (error instanceof ManageError) {
            if (adapter.isAuthError(error)) {
                res.status(403);
                res.json({
                    error: RESOURCE_ACCESS_HELP[row.kind] ?? `${name} rejected this request.`,
                    code: "missing_access",
                });
                return;
            }

            if (error.status === 404) {
                res.status(404);
                res.json({ error: `${name} couldn't find that.` });
                return;
            }

            if (error.status >= 400 && error.status < 500 && error.status !== 429) {
                res.status(422);
                res.json({ error: error.message });
                return;
            }
        }

        console.error(`[provider-resources] ${row.kind} call failed:`, error instanceof Error ? error.message : error);
        res.status(502);
        res.json({ error: `Couldn't reach ${name}. Try again in a moment.` });
    }
}

function invalid(res: TylixResponse, errors: Record<string, string[]>) {
    res.status(422);
    res.json({ errors });
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // ---- Machines ----

    router.get(
        "/api/providers/:id/machines",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.machines());
        }),
    );

    router.post(
        "/api/providers/:id/machines/:machineId/:action",
        auth(async (req, res) => {
            const action = String(req.params.action);
            if (!validateMachineAction(action)) {
                res.status(422);
                res.json({ error: "Choose boot, shutdown or reboot." });
                return;
            }

            await run(
                req,
                res,
                (adapter) => adapter.machineAction(String(req.params.machineId), action as MachineAction),
                204,
            );
        }),
    );

    // ---- Firewalls ----

    router.get(
        "/api/providers/:id/firewalls",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.firewalls());
        }),
    );

    router.post(
        "/api/providers/:id/firewalls",
        auth(async (req, res) => {
            const result = validateFirewallCreate(req.body);
            if (!result.valid) return invalid(res, result.errors);

            const input = normalizeFirewallCreate(req.body);
            await run(req, res, (adapter) => adapter.createFirewall(input.label), 201);
        }),
    );

    router.put(
        "/api/providers/:id/firewalls/:firewallId/rules",
        auth(async (req, res) => {
            const result = validateFirewallRules(req.body);
            if (!result.valid) return invalid(res, result.errors);

            const input = normalizeFirewallRules(req.body);
            await run(req, res, (adapter) => adapter.setFirewallRules(String(req.params.firewallId), input));
        }),
    );

    router.delete(
        "/api/providers/:id/firewalls/:firewallId",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.removeFirewall(String(req.params.firewallId)), 204);
        }),
    );

    // ---- Volumes ----

    router.get(
        "/api/providers/:id/volumes",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.volumes());
        }),
    );

    router.post(
        "/api/providers/:id/volumes",
        auth(async (req, res) => {
            const result = validateVolumeCreate(req.body);
            if (!result.valid) return invalid(res, result.errors);

            const input = normalizeVolumeCreate(req.body);
            await run(req, res, (adapter) => adapter.createVolume(input), 201);
        }),
    );

    router.post(
        "/api/providers/:id/volumes/:volumeId/attach",
        auth(async (req, res) => {
            const result = validateMachineRef(req.body);
            if (!result.valid) return invalid(res, result.errors);

            const input = normalizeMachineRef(req.body);
            await run(
                req,
                res,
                (adapter) => adapter.attachVolume(String(req.params.volumeId), input.machineId),
                204,
            );
        }),
    );

    router.post(
        "/api/providers/:id/volumes/:volumeId/detach",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.detachVolume(String(req.params.volumeId)), 204);
        }),
    );

    router.delete(
        "/api/providers/:id/volumes/:volumeId",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.removeVolume(String(req.params.volumeId)), 204);
        }),
    );

    // ---- Images ----

    router.get(
        "/api/providers/:id/images",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.images());
        }),
    );

    router.post(
        "/api/providers/:id/images",
        auth(async (req, res) => {
            const result = validateImageCreate(req.body);
            if (!result.valid) return invalid(res, result.errors);

            const input = normalizeImageCreate(req.body);
            await run(req, res, (adapter) => adapter.createImage(input.machineId, input.label), 201);
        }),
    );

    router.put(
        "/api/providers/:id/images/:imageId",
        auth(async (req, res) => {
            const result = validateImageRename(req.body);
            if (!result.valid) return invalid(res, result.errors);

            const input = normalizeImageRename(req.body);
            await run(req, res, (adapter) => adapter.renameImage(String(req.params.imageId), input.label), 204);
        }),
    );

    router.delete(
        "/api/providers/:id/images/:imageId",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.removeImage(String(req.params.imageId)), 204);
        }),
    );

    // ---- IPs ----

    router.get(
        "/api/providers/:id/ips",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.ips());
        }),
    );

    router.post(
        "/api/providers/:id/ips",
        auth(async (req, res) => {
            const result = validateIpAllocate(req.body);
            if (!result.valid) return invalid(res, result.errors);

            const input = normalizeIpAllocate(req.body);
            await run(req, res, (adapter) => adapter.allocateIp(input), 201);
        }),
    );

    router.put(
        "/api/providers/:id/ips/:ipId",
        auth(async (req, res) => {
            const result = validateRdns(req.body);
            if (!result.valid) return invalid(res, result.errors);

            const input = normalizeRdns(req.body);
            await run(req, res, (adapter) => adapter.setRdns(String(req.params.ipId), input.rdns), 204);
        }),
    );

    router.delete(
        "/api/providers/:id/ips/:ipId",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.removeIp(String(req.params.ipId)), 204);
        }),
    );
}