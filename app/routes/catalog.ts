/**
 * Read-only catalog for the create-server form: regions, plans and OS
 * images for a provider. Behind auth like every other API route.
 *
 *   GET /api/catalog/linode               -> { regions, images, plans }
 *   GET /api/catalog/linode?region=us-ord -> plans priced for that region
 *
 * Linode's catalog is public and changes rarely, so each answer is cached
 * in memory for 10 minutes.
 */

import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { LinodeClient } from "../services/LinodeClient.js";

const TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: unknown }>();

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
        "/api/catalog/linode",
        auth(async (req, res) => {
            // ASSUMPTION: the request exposes parsed query params as req.query.
            const query = (req as unknown as { query?: Record<string, string> }).query ?? {};
            const region = typeof query.region === "string" ? query.region : "";

            try {
                const [regions, images, plans] = await Promise.all([
                    cached("linode:regions", () => LinodeClient.regions()),
                    cached("linode:images", () => LinodeClient.images()),
                    cached(`linode:plans:${region}`, () => LinodeClient.plans(region || undefined)),
                ]);

                if (region && !regions.some((r) => r.id === region)) {
                    res.status(422);
                    return res.json({ error: "Unknown region." });
                }

                return res.json({ regions, images, plans });
            } catch {
                res.status(502);
                return res.json({ error: "Couldn't load the Linode catalog. Try again in a moment." });
            }
        }),
    );
}