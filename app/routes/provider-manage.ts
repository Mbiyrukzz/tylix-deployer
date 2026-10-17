/**
 * Provider management routes: domains, DNS records and billing.
 *
 * GET    /api/providers/:id/domains
 * POST   /api/providers/:id/domains                          { name, email }
 * DELETE /api/providers/:id/domains/:domainId
 * GET    /api/providers/:id/domains/:domainId/records        -> { domain, records }
 * POST   /api/providers/:id/domains/:domainId/records        { type, name, value, ttl, priority }
 * PUT    /api/providers/:id/domains/:domainId/records/:recordId
 * DELETE /api/providers/:id/domains/:domainId/records/:recordId
 * GET    /api/providers/:id/billing
 *
 * Same rules as everywhere else: the connection must be the caller's (404
 * otherwise), the credentials are decrypted here and never returned, and a
 * token that lacks the Domains/Account access answers 403 with code
 * "missing_access" and a message saying how to fix it.
 *
 * ASSUMPTION: Router exposes put() and delete() like get() and post().
 */

import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { Provider } from "../models/Provider.js";
import { providerName, providerSecret } from "../services/ProviderAdapter.js";
import {
    manageFor,
    MANAGE_KINDS,
    ACCESS_HELP,
    ManageError,
    type ManageAdapter,
} from "../services/ProviderManage.js";
import {
    validateDomain,
    normalizeDomain,
    validateDomainSettings,
    normalizeDomainSettings,
    validateRecord,
    normalizeRecord,
} from "../validators/DnsValidator.js";

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
    job: (adapter: ManageAdapter, kind: string) => Promise<unknown>,
    success = 200,
): Promise<void> {
    const row = (await Provider.find(req.params.id)) as ProviderRow | null;

    if (!row || row.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Provider connection not found." });
        return;
    }

    const name = providerName(row.kind);

    if (!MANAGE_KINDS.includes(row.kind)) {
        res.status(422);
        res.json({ error: `Domains and billing aren't available for ${name} yet.`, code: "unsupported" });
        return;
    }

    let adapter: ManageAdapter;
    try {
        adapter = manageFor(row.kind, providerSecret(row));
    } catch (error) {
        console.error(`[provider-manage] couldn't build the ${row.kind} adapter:`, error);
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
                res.json({ error: ACCESS_HELP[row.kind] ?? `${name} rejected this request.`, code: "missing_access" });
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

        console.error(`[provider-manage] ${row.kind} call failed:`, error instanceof Error ? error.message : error);
        res.status(502);
        res.json({ error: `Couldn't reach ${name}. Try again in a moment.` });
    }
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // ---- Domains ----

    router.get(
        "/api/providers/:id/domains",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.domains());
        }),
    );

    router.post(
        "/api/providers/:id/domains",
        auth(async (req, res) => {
            const result = validateDomain(req.body);
            if (!result.valid) {
                res.status(422);
                res.json({ errors: result.errors });
                return;
            }

            const input = normalizeDomain(req.body);

            await run(
                req,
                res,
                async (adapter, kind) => {
                    if (kind === "linode" && !input.email) {
                        throw new ManageError("Enter the email address for the domain's SOA record.", 422);
                    }
                    return adapter.createDomain(input.name, input.email);
                },
                201,
            );
        }),
    );

    router.put(
        "/api/providers/:id/domains/:domainId",
        auth(async (req, res) => {
            const result = validateDomainSettings(req.body);
            if (!result.valid) {
                res.status(422);
                res.json({ errors: result.errors });
                return;
            }

            const input = normalizeDomainSettings(req.body);

            await run(req, res, (adapter) => adapter.updateDomain(String(req.params.domainId), input));
        }),
    );

    router.delete(
        "/api/providers/:id/domains/:domainId",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.removeDomain(String(req.params.domainId)), 204);
        }),
    );

    // ---- Records ----

    router.get(
        "/api/providers/:id/domains/:domainId/records",
        auth(async (req, res) => {
            await run(req, res, async (adapter) => {
                const domainId = String(req.params.domainId);
                const [domain, records] = await Promise.all([
                    adapter.getDomain(domainId),
                    adapter.records(domainId),
                ]);
                return { domain, records };
            });
        }),
    );

    router.post(
        "/api/providers/:id/domains/:domainId/records",
        auth(async (req, res) => {
            const result = validateRecord(req.body);
            if (!result.valid) {
                res.status(422);
                res.json({ errors: result.errors });
                return;
            }

            const input = normalizeRecord(req.body);

            await run(req, res, (adapter) => adapter.addRecord(String(req.params.domainId), input), 201);
        }),
    );

    router.put(
        "/api/providers/:id/domains/:domainId/records/:recordId",
        auth(async (req, res) => {
            const result = validateRecord(req.body);
            if (!result.valid) {
                res.status(422);
                res.json({ errors: result.errors });
                return;
            }

            const input = normalizeRecord(req.body);

            await run(req, res, (adapter) =>
                adapter.updateRecord(String(req.params.domainId), String(req.params.recordId), input),
            );
        }),
    );

    router.delete(
        "/api/providers/:id/domains/:domainId/records/:recordId",
        auth(async (req, res) => {
            await run(
                req,
                res,
                (adapter) => adapter.removeRecord(String(req.params.domainId), String(req.params.recordId)),
                204,
            );
        }),
    );

    // ---- Billing ----

    router.get(
        "/api/providers/:id/billing",
        auth(async (req, res) => {
            await run(req, res, (adapter) => adapter.billing());
        }),
    );

    router.get(
        "/api/providers/:id/billing/invoices/:invoiceId",
        auth(async (req, res) => {
            await run(req, res, async (adapter) => {
                if (!adapter.invoiceItems) {
                    throw new ManageError("Invoice details aren't available for this provider.", 422);
                }
                return adapter.invoiceItems(String(req.params.invoiceId));
            });
        }),
    );
}