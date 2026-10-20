/**
 * Read-only catalog for the create-server form: regions, plans and OS
 * images for a provider. Behind auth like every other API route.
 *
 *   GET /api/catalog/linode                          -> { regions, images, plans }
 *   GET /api/catalog/linode?region=us-ord            -> plans priced for that region
 *   GET /api/catalog/hetzner?provider=<id>           -> same shape, via that connection
 *   GET /api/catalog/hetzner?provider=<id>&region=nbg1
 *   GET /api/catalog/digitalocean?provider=<id>&region=nyc3
 *   GET /api/catalog/aws?provider=<id>&region=eu-west-1
 *
 *   - Linode's catalog is public: no token, no `provider` param needed.
 *   - Every other provider needs the connection's credentials for EVERY call,
 *     including the catalog. The caller passes the id of one of their own
 *     connections, and the secret is decrypted here, server-side. It never
 *     reaches the client.
 *
 * Each answer is cached in memory for 10 minutes. Credential-based answers are
 * cached per connection, so one team's credentials are never what serves another
 * team. Failed lookups are not cached.
 *
 * Every plan carries `currency` ("USD" for Linode, DigitalOcean, Vultr and AWS,
 * "EUR" for Hetzner). AWS plans have monthly = 0: prices are not looked up.
 */

import type { Router } from "@tylix/core";
import { Provider } from "../models/Provider.js";
import { requireTeam, teamIdOfRow } from "../services/TeamScope.js";

import { adapterFor, providerName, providerSecret, PROVIDER_KINDS } from "../services/ProviderAdapter.js";

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

/** Kinds whose catalog is public. Every other kind needs a connection's credentials. */
const PUBLIC_CATALOG = ["linode"];

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;

    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
}

type Handler = Parameters<Router["get"]>[1];

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/catalog/:kind",
        auth(async (req, res) => {
            const kind = String(req.params.kind ?? "").toLowerCase();

            if (!(PROVIDER_KINDS as string[]).includes(kind)) {
                res.status(404);
                return res.json({ error: "Unknown provider." });
            }

            const name = providerName(kind);

            // ASSUMPTION: the request exposes parsed query params as req.query.
            const query = (req as unknown as { query?: Record<string, string> }).query ?? {};
            const region = typeof query.region === "string" ? query.region : "";

            // Which secret (if any) the catalog call is made with.
            let secret = "";
            let scope = "public";

            if (!PUBLIC_CATALOG.includes(kind)) {
                const teamId = requireTeam(req as any, res as any);
                if (!teamId) return;

                const providerId = Number(query.provider);

                if (!Number.isInteger(providerId) || providerId <= 0) {
                    res.status(422);
                    return res.json({ error: `Choose a ${name} connection first.` });
                }

                const row = (await Provider.find(providerId)) as {
                    id: number;
                    user_id: number;
                    team_id: number | null;
                    kind: string;
                    api_token: string;
                    credentials: string;
                } | null;

                // A connection on another team (or the wrong kind) answers 404, like everywhere else.
                if (!row || (await teamIdOfRow(row)) !== teamId || row.kind !== kind) {
                    res.status(404);
                    return res.json({ error: "Provider connection not found." });
                }

                try {
                    secret = providerSecret(row);
                } catch (error) {
                    console.error(`[catalog] ${kind} connection ${row.id} has unreadable credentials:`, error);
                    res.status(422);
                    return res.json({
                        error: `This ${name} connection can't be used. Edit it and paste the credentials again.`,
                    });
                }
                scope = `provider:${row.id}`;
            }

            let adapter;
            try {
                adapter = adapterFor(kind, secret);
            } catch (error) {
                console.error(`[catalog] couldn't build the ${kind} adapter:`, error);
                res.status(422);
                return res.json({
                    error: `This ${name} connection can't be used. Edit it and paste the credentials again.`,
                });
            }

            try {
                const [regions, images, plans] = await Promise.all([
                    cached(`${kind}:${scope}:regions`, () => adapter.regions()),
                    cached(`${kind}:${scope}:images`, async () => adapter.images()),
                    cached(`${kind}:${scope}:plans:${region}`, () => adapter.plans(region || undefined)),
                ]);

                if (region && !regions.some((r) => r.id === region)) {
                    res.status(422);
                    return res.json({ error: "Unknown region." });
                }

                return res.json({ regions, images, plans });
            } catch (error) {
                // Log the real cause server-side. The client only gets a generic message.
                console.error(`[catalog] ${kind} lookup failed (region="${region}"):`, error);

                // Revoked or expired credentials: tell them how to fix it
                // instead of showing a generic "try again".
                if (adapter.isAuthError(error)) {
                    res.status(422);
                    return res.json({
                        error: `${name} rejected this connection's credentials. Edit the connection and paste new ones.`,
                    });
                }

                res.status(502);
                return res.json({ error: `Couldn't load the ${name} catalog. Try again in a moment.` });
            }
        }),
    );
}