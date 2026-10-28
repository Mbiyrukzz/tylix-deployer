/**
 * Public plan list. No login needed.
 *
 * GET /api/pricing   { plans: [{ id, name, price_usd, limits }] }
 */

import type { Router } from "@tylix/core";
import { PLANS } from "../services/Plans.js";

export async function routes(router: Router) {
  router.get("/api/pricing", async (_req, res) => {
    return res.json({
      plans: PLANS.map((p) => ({
        id: p.id,
        name: p.name,
        price_usd: p.priceUsd,
        limits: p.limits, // { members, servers, sites, providers }, null = unlimited
      })),
    });
  });
}