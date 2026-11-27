/**
 * Importing what already runs on a server (for example a server moved over
 * from Vito). See ServerImport for what is read and what changes.
 *
 * POST /api/servers/:id/import/scan   admin: read-only scan of the server
 * POST /api/servers/:id/import        admin: adopt the picked items
 *   body { sites: [{ key, type?, php_version?, source_control_id?, https_remote? }],
 *          databases: [key], workers: [key], cron: [key] }
 *
 * The scan is a POST because it runs commands as root on the server, even
 * though it changes nothing. Both are admin only, team scoped (another team's
 * server is a 404), refused while the team is view only, and rate limited.
 * Importing sites counts against the plan's site limit. Every import is
 * written to the server log.
 */

import type { Router } from "@tylix/core";
import { Server } from "../models/Server.js";
import { createGuard, audit } from "../services/RouteGuard.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { requireActive, requireWithin } from "../services/EntitlementService.js";
import { ServerImport, ImportError, type ImportServer, type ImportPicks, type SitePick } from "../services/ServerImport.js";

type Handler = Parameters<Router["post"]>[1];

const scanGuard = createGuard({ max: 30, windowMs: 15 * 60_000, scope: "team", what: "server scans" });
const importGuard = createGuard({ max: 10, windowMs: 15 * 60_000, scope: "team", what: "imports" });

/** One import at a time per server: two would race on the same nginx files and crontabs. */
const running = new Set<number>();

const strings = (v: unknown, max = 200): string[] =>
    Array.isArray(v) ? v.slice(0, max).map((x) => String(x)).filter((x) => /^[A-Za-z0-9_.-]{1,64}$/.test(x)) : [];

function sitePicks(v: unknown): SitePick[] {
    if (!Array.isArray(v)) return [];
    return v.slice(0, 100).flatMap((raw) => {
        const p = (raw ?? {}) as Record<string, unknown>;
        const key = String(p.key ?? "");
        if (!/^[a-f0-9]{16}$/.test(key)) return [];
        return [
            {
                key,
                type: typeof p.type === "string" ? p.type : undefined,
                php_version: typeof p.php_version === "string" ? p.php_version : undefined,
                source_control_id: Number(p.source_control_id) || 0,
                https_remote: p.https_remote !== false,
            },
        ];
    });
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;
            if (!(await requireActive(res as any, teamId))) return;
            return handler(req, res, next);
        });

    async function ownedServer(req: any, res: any): Promise<ImportServer | null> {
        const teamId = requireTeam(req, res);
        if (!teamId) return null;
        const server = (await Server.find(req.params.id)) as ImportServer | null;
        if (!server || Number(server.team_id) !== teamId) {
            res.status(404);
            res.json({ error: "Server not found." });
            return null;
        }
        return server;
    }

    function failed(res: any, error: unknown) {
        if (error instanceof ImportError) {
            res.status(error.status);
            return res.json({ error: error.message });
        }
        console.error("[import]", error);
        res.status(500);
        return res.json({ error: "Something went wrong while reading the server." });
    }

    router.post(
        "/api/servers/:id/import/scan",
        write(async (req, res) => {
            const server = await ownedServer(req, res);
            if (!server) return;
            if (!scanGuard(req as any, res as any)) return;

            try {
                return res.json(await ServerImport.scan(server));
            } catch (error) {
                return failed(res, error);
            }
        }),
    );

    router.post(
        "/api/servers/:id/import",
        write(async (req, res) => {
            const server = await ownedServer(req, res);
            if (!server) return;

            const b = (req.body ?? {}) as Record<string, unknown>;
            const picks: ImportPicks = {
                sites: sitePicks(b.sites),
                databases: strings(b.databases),
                workers: strings(b.workers),
                cron: strings(b.cron),
            };
            const total = picks.sites.length + picks.databases.length + picks.workers.length + picks.cron.length;
            if (total === 0) {
                res.status(422);
                return res.json({ error: "Pick at least one thing to import." });
            }

            const teamId = Number(req.user?.teamId);
            if (picks.sites.length > 0 && !(await requireWithin(res as any, teamId, "sites", picks.sites.length))) return;

            if (running.has(server.id)) {
                res.status(409);
                return res.json({ error: "An import is already running on this server." });
            }
            if (!importGuard(req as any, res as any)) return;

            running.add(server.id);
            try {
                const report = await ServerImport.run(server, picks, { userId: Number(req.user?.userId), teamId });
                const ok = report.filter((r) => r.ok);

                for (const r of ok.filter((x) => x.kind === "site")) {
                    await audit({
                        userId: Number(req.user?.userId),
                        teamId,
                        serverId: server.id,
                        event: "site.imported",
                        level: "success",
                        message: `Site ${r.name} was imported from the server.`,
                        meta: { site_id: r.id },
                    });
                }
                await audit({
                    userId: Number(req.user?.userId),
                    teamId,
                    serverId: server.id,
                    event: "server.imported",
                    level: ok.length === report.length ? "success" : "warning",
                    message: `Imported ${ok.length} of ${report.length} items from the server.`,
                    meta: {
                        sites: ok.filter((r) => r.kind === "site").length,
                        databases: ok.filter((r) => r.kind === "database").length,
                        workers: ok.filter((r) => r.kind === "worker").length,
                        cron: ok.filter((r) => r.kind === "cron").length,
                        failed: report.length - ok.length,
                    },
                });

                return res.json({ report });
            } catch (error) {
                return failed(res, error);
            } finally {
                running.delete(server.id);
            }
        }),
    );
}
