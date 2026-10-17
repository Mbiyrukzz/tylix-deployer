/**
 * Registrar routes: connections (CRUD), then domains, DNS, nameservers,
 * settings, email forwarding, renewals and billing.
 *
 * GET    /api/registrars
 * POST   /api/registrars
 * GET    /api/registrars/:id
 * PUT    /api/registrars/:id
 * DELETE /api/registrars/:id
 *
 * GET    /api/registrars/:id/domains
 * GET    /api/registrars/:id/renewals                         domains with an expiry date, soonest first
 * GET    /api/registrars/:id/billing                          balance + billing history (registrars that offer it)
 * GET    /api/registrars/:id/domains/:domainId/records
 * POST   /api/registrars/:id/domains/:domainId/records        { type, name, value, ttl, priority }
 * PUT    /api/registrars/:id/domains/:domainId/records/:recordId
 * DELETE /api/registrars/:id/domains/:domainId/records/:recordId
 * GET    /api/registrars/:id/domains/:domainId/nameservers
 * PUT    /api/registrars/:id/domains/:domainId/nameservers    { servers: [] }
 * PUT    /api/registrars/:id/domains/:domainId/settings       { autoRenew?, locked? }
 * GET    /api/registrars/:id/domains/:domainId/forwarders
 * POST   /api/registrars/:id/domains/:domainId/forwarders     { from, to }
 * DELETE /api/registrars/:id/domains/:domainId/forwarders/:forwarderId
 *
 * Same rules as the provider routes: the connection must be the caller's (404
 * otherwise), credentials are decrypted here and never returned, and a feature
 * the registrar doesn't have answers 422 with code "unsupported".
 *
 * Set REGISTRAR_DEBUG=1 for per-request logging. Logs never include request
 * bodies or query strings: they can carry API keys.
 *
 * ASSUMPTION: DnsValidator's validateRecord/normalizeRecord return
 * { type, name, value, ttl, priority }, as the provider routes use them.
 */

import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { Registrar } from "../models/Registrar.js";
import { RegistrarController } from "../controllers/RegistrarController.js";
import {
    registrarFor,
    registrarName,
    registrarSecret,
    featuresOf,
    type RegistrarAdapter,
    type RegistrarFeature,
    type DnsRecordInput,
} from "../services/RegistrarAdapter.js";
import { RegistrarError } from "../services/registrars/http.js";
import { validateRecord, normalizeRecord } from "../validators/DnsValidator.js";

type Handler = Parameters<Router["get"]>[1];

interface Row {
    id: number;
    user_id: number;
    kind: string;
    api_token: string;
    credentials: string;
}

const DEBUG = process.env.REGISTRAR_DEBUG === "1";

const HOST = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Loads the caller's connection, checks the feature, builds the adapter, runs the job, maps every failure. */
async function run(
    req: TylixRequest,
    res: TylixResponse,
    feature: RegistrarFeature,
    job: (adapter: RegistrarAdapter) => Promise<unknown>,
    success = 200,
): Promise<void> {
    const row = (await Registrar.find(req.params.id)) as Row | null;

    if (!row || row.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Registrar connection not found." });
        return;
    }

    const name = registrarName(row.kind);
    const started = Date.now();

    if (DEBUG) console.log(`[registrars] ${feature} on #${row.id} (${row.kind}) for user ${row.user_id}`);

    if (!featuresOf(row.kind).includes(feature)) {
        res.status(422);
        res.json({ error: `${name} doesn't offer that through its API.`, code: "unsupported" });
        return;
    }

    let adapter: RegistrarAdapter;
    try {
        adapter = registrarFor(row.kind, registrarSecret(row));
    } catch (error) {
        console.error(`[registrar-manage] couldn't build the ${row.kind} adapter:`, error);
        res.status(422);
        res.json({ error: `This ${name} connection can't be used. Edit it and paste the credentials again.` });
        return;
    }

    try {
        const result = await job(adapter);

        if (DEBUG) console.log(`[registrars] ${feature} ok in ${Date.now() - started}ms`);

        if (success === 204) {
            res.status(204);
            res.end();
            return;
        }
        res.status(success);
        res.json(result);
    } catch (error) {
        if (error instanceof RegistrarError) {
            if (adapter.isAuthError(error)) {
                res.status(403);
                res.json({ error: `${name} refused this request. ${error.message}`, code: "missing_access" });
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

        console.error(`[registrar-manage] ${row.kind} call failed:`, error instanceof Error ? error.message : error);
        res.status(502);
        res.json({ error: `Couldn't reach ${name}. Try again in a moment.` });
    }
}

function toInput(i: Record<string, unknown>): DnsRecordInput {
    const priority = i.priority === undefined || i.priority === null || i.priority === "" ? null : Number(i.priority);
    return {
        type: String(i.type).toUpperCase(),
        name: String(i.name || "@"),
        value: String(i.value),
        ttl: Number(i.ttl) || 600,
        priority: Number.isFinite(priority) ? priority : null,
    };
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    console.log("[registrars] routes registered");

    const base = "/api/registrars/:id";
    const ctrl = new RegistrarController();

    // ---- Connections (CRUD) ----

    router.get(
        "/api/registrars",
        auth(async (req, res) => {
            await ctrl.index(req, res);
        }),
    );

    router.post(
        "/api/registrars",
        auth(async (req, res) => {
            await ctrl.store(req, res);
        }),
    );

    router.get(
        base,
        auth(async (req, res) => {
            await ctrl.show(req, res);
        }),
    );

    router.put(
        base,
        auth(async (req, res) => {
            await ctrl.update(req, res);
        }),
    );

    router.delete(
        base,
        auth(async (req, res) => {
            await ctrl.destroy(req, res);
        }),
    );

    // ---- Domains ----

    router.get(
        `${base}/domains`,
        auth(async (req, res) => {
            await run(req, res, "domains", (a) => a.domains());
        }),
    );

    // What expires when, and whether it will renew by itself. Every registrar can do this.
    router.get(
        `${base}/renewals`,
        auth(async (req, res) => {
            await run(req, res, "domains", async (a) => {
                const now = Date.now();
                return (await a.domains())
                    .filter((d) => d.expires)
                    .map((d) => ({
                        ...d,
                        daysLeft: Math.ceil((new Date(d.expires).getTime() - now) / 86_400_000),
                    }))
                    .sort((x, y) => x.daysLeft - y.daysLeft);
            });
        }),
    );

    // ---- Billing ----

    // Account balance and billing history. Only registrars whose API exposes it declare
    // the "billing" feature; the rest answer 422 "unsupported" and the page says so.
    router.get(
        `${base}/billing`,
        auth(async (req, res) => {
            await run(req, res, "billing", (a) => a.billing!());
        }),
    );

    // ---- DNS records ----

    router.get(
        `${base}/domains/:domainId/records`,
        auth(async (req, res) => {
            await run(req, res, "dns", async (a) => {
                const id = String(req.params.domainId);
                const [records, nameservers] = await Promise.all([a.records(id), a.nameservers(id).catch(() => [])]);
                return { records, nameservers };
            });
        }),
    );

    router.post(
        `${base}/domains/:domainId/records`,
        auth(async (req, res) => {
            const result = validateRecord(req.body);
            if (!result.valid) {
                res.status(422);
                res.json({ errors: result.errors });
                return;
            }
            const input = toInput(normalizeRecord(req.body) as unknown as Record<string, unknown>);
            await run(req, res, "dns", (a) => a.addRecord(String(req.params.domainId), input), 201);
        }),
    );

    router.put(
        `${base}/domains/:domainId/records/:recordId`,
        auth(async (req, res) => {
            const result = validateRecord(req.body);
            if (!result.valid) {
                res.status(422);
                res.json({ errors: result.errors });
                return;
            }
            const input = toInput(normalizeRecord(req.body) as unknown as Record<string, unknown>);
            await run(req, res, "dns", (a) =>
                a.updateRecord(String(req.params.domainId), String(req.params.recordId), input),
            );
        }),
    );

    router.delete(
        `${base}/domains/:domainId/records/:recordId`,
        auth(async (req, res) => {
            await run(
                req,
                res,
                "dns",
                (a) => a.removeRecord(String(req.params.domainId), String(req.params.recordId)),
                204,
            );
        }),
    );

    // ---- Nameservers ----

    router.get(
        `${base}/domains/:domainId/nameservers`,
        auth(async (req, res) => {
            await run(req, res, "nameservers", async (a) => ({
                servers: await a.nameservers(String(req.params.domainId)),
                editable: typeof a.setNameservers === "function",
            }));
        }),
    );

    // Pointing a domain at the wrong nameservers takes its site AND its email down,
    // so the UI should make the user type the domain name before sending this.
    router.put(
        `${base}/domains/:domainId/nameservers`,
        auth(async (req, res) => {
            const raw = (req.body as { servers?: unknown })?.servers;
            const servers = Array.isArray(raw) ? raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean) : [];

            if (servers.length < 2 || servers.length > 13 || servers.some((s) => !HOST.test(s))) {
                res.status(422);
                res.json({ errors: { servers: ["Enter between 2 and 13 valid nameserver hostnames."] } });
                return;
            }

            await run(req, res, "nameservers", async (a) => {
                if (!a.setNameservers) throw new RegistrarError("This registrar's nameservers can't be changed here.", 422);
                await a.setNameservers(String(req.params.domainId), servers);
                return { servers };
            });
        }),
    );

    // ---- Settings (auto-renew, transfer lock) ----

    router.put(
        `${base}/domains/:domainId/settings`,
        auth(async (req, res) => {
            const body = (req.body ?? {}) as { autoRenew?: unknown; locked?: unknown };
            const hasRenew = typeof body.autoRenew === "boolean";
            const hasLock = typeof body.locked === "boolean";

            if (!hasRenew && !hasLock) {
                res.status(422);
                res.json({ error: "Send autoRenew and/or locked as true or false." });
                return;
            }

            await run(req, res, "settings", async (a) => {
                const id = String(req.params.domainId);
                if (hasRenew && a.setAutoRenew) await a.setAutoRenew(id, body.autoRenew as boolean);
                if (hasLock && a.setLock) await a.setLock(id, body.locked as boolean);
                return { ok: true };
            });
        }),
    );

    // ---- Email forwarding ----

    router.get(
        `${base}/domains/:domainId/forwarders`,
        auth(async (req, res) => {
            await run(req, res, "forwarding", (a) => a.forwarders!(String(req.params.domainId)));
        }),
    );

    router.post(
        `${base}/domains/:domainId/forwarders`,
        auth(async (req, res) => {
            const b = (req.body ?? {}) as { from?: unknown; to?: unknown };
            const from = typeof b.from === "string" ? b.from.trim().toLowerCase() : "";
            const to = typeof b.to === "string" ? b.to.trim().toLowerCase() : "";
            const errors: Record<string, string[]> = {};

            if (!EMAIL.test(from)) errors.from = ["Enter the address on your domain, like info@example.com."];
            if (!EMAIL.test(to)) errors.to = ["Enter the address to forward to."];
            if (Object.keys(errors).length > 0) {
                res.status(422);
                res.json({ errors });
                return;
            }

            await run(req, res, "forwarding", (a) => a.addForwarder!(String(req.params.domainId), from, to), 201);
        }),
    );

    router.delete(
        `${base}/domains/:domainId/forwarders/:forwarderId`,
        auth(async (req, res) => {
            await run(
                req,
                res,
                "forwarding",
                (a) => a.removeForwarder!(String(req.params.domainId), String(req.params.forwarderId)),
                204,
            );
        }),
    );
}