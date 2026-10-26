/**
 * Legal documents. Public, no login needed.
 *
 * GET /api/legal   { terms, privacy } current version and effective date of each
 *
 * The pages themselves are app/pages/Terms.tyx (/terms) and
 * app/pages/Privacy.tyx (/privacy). When you change either one, bump its
 * version and effective date here and in the page.
 */

import type { Router } from "@tylix/core";

const LEGAL = {
    terms: { version: "2026-10-26", effective: "2026-10-26", url: "/terms" },
    privacy: { version: "2026-10-26", effective: "2026-10-26", url: "/privacy" },
};

export async function routes(router: Router) {
    router.get("/api/legal", async (_req, res) => {
        return res.json(LEGAL);
    });
}