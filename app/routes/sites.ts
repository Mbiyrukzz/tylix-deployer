/**
 * Sites inside a server.
 *
 * GET  /api/sites       the team's sites (any member)
 * POST /api/sites       (admin) validate, create and queue a CreateSite job
 * GET  /api/sites/:id   one site (the page polls this for step/status/log)
 *
 * Every value validated here ends up in shell commands and nginx config
 * inside the job, so the patterns below are strict on purpose.
 *
 * Writes are refused with 402 while the team is view only (see write()),
 * and creating a site is checked against the team's plan limit.
 *
 * Hardening: creating a site is rate limited per team (it queues a job that
 * runs commands on the server) and every created site is written to the
 * server log.
 */

import type { Router } from "@tylix/core";
import { dispatch } from "@tylix/core";
import { Server } from "../models/Server.js";
import { Site } from "../models/Site.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { createGuard, audit } from "../services/RouteGuard.js";
import { requireTeam, requireRole, teamIdOfRow } from "../services/TeamScope.js";
import { requireActive, requireWithin } from "../services/EntitlementService.js";

type Handler = Parameters<Router["post"]>[1];

type SiteRow = {
    id: number;
    user_id: number;
    team_id: number | null;
    server_id: number;
    type: string;
    domain: string;
    aliases: string;
    isolated_user: string;
    php_version: string;
    port: number;
    source_control_id: number;
    repository: string;
    branch: string;
    web_directory: string;
    install_deps: number | boolean;
    status: string;
    step: string;
    error: string;
    log: string;
    created_at: string;
};

const NODE_TYPES = ["tylix", "nextjs", "nodejs"];
const PHP_TYPES = ["laravel", "php"];
const TYPES = [...NODE_TYPES, ...PHP_TYPES, "static"];
const COMMAND = /^[^\r\n\0]{1,200}$/;
const PHP_VERSIONS = ["8.1", "8.2", "8.3", "8.4"];
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const USER = /^[a-z][a-z0-9_-]{0,31}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,100}$/;
const RESERVED_USERS = ["root", "www-data", "nginx", "ubuntu", "admin", "tylix", "mysql", "postgres", "redis"];

const createGuardPerTeam = createGuard({ max: 20, windowMs: 60 * 60_000, scope: "team", what: "site creations" });

function present(row: SiteRow) {
    let aliases: string[] = [];
    try {
        aliases = JSON.parse(row.aliases || "[]");
    } catch {
        aliases = [];
    }
    return { ...row, aliases, install_deps: Boolean(row.install_deps) };
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // Admin-only, and refused (402) while the team is view only.
    // A route registered with write() answers 403 to a plain member.
    // Reads and anything a locked team must still do (billing, login) stay on plain auth().
    const write = (handler: Handler): Handler =>
        auth(async (req, res, next) => {
            if (!requireRole(req as any, res as any, "admin")) return;

            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            if (!(await requireActive(res as any, teamId))) return;

            return handler(req, res, next);
        });

    router.get(
        "/api/sites",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const rows = (await Site.all()) as SiteRow[];
            const own = rows
                .filter((r) => Number(r.team_id) === teamId)
                .sort((a, b) => b.id - a.id);
            return res.json(own.map(present));
        }),
    );

    router.get(
        "/api/sites/:id",
        auth(async (req, res) => {
            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const row = (await Site.find(req.params.id)) as SiteRow | null;

            if (!row || Number(row.team_id) !== teamId) {
                res.status(404);
                return res.json({ error: "Site not found." });
            }

            return res.json(present(row));
        }),
    );

    router.post(
        "/api/sites",
        write(async (req, res) => {
            const b = (req.body || {}) as Record<string, unknown>;
            const errors: Record<string, string[]> = {};
            const fail = (field: string, message: string) => {
                (errors[field] ||= []).push(message);
            };

            const teamId = requireTeam(req as any, res as any);
            if (!teamId) return;

            const server = (await Server.find(Number(b.server_id))) as
                | { id: number; user_id: number; team_id: number | null }
                | null;

            if (!server || Number(server.team_id) !== teamId) {
                res.status(404);
                return res.json({ error: "Server not found." });
            }

            const onServer = ((await Site.all()) as SiteRow[]).filter((s) => s.server_id === server.id);

            const type = String(b.type || "");
            if (!TYPES.includes(type)) fail("type", "Choose a valid site type.");

            const domain = String(b.domain || "").trim().toLowerCase();
            if (!DOMAIN.test(domain)) fail("domain", "Enter a valid domain, e.g. example.com.");

            const aliases = Array.from(
                new Set(
                    (Array.isArray(b.aliases) ? b.aliases : [])
                        .map((a) => String(a).trim().toLowerCase())
                        .filter(Boolean),
                ),
            );
            if (aliases.length > 20) fail("aliases", "At most 20 aliases are allowed.");
            for (const a of aliases) {
                if (!DOMAIN.test(a)) fail("aliases", `"${a}" is not a valid domain.`);
                if (a === domain) fail("aliases", "An alias can't be the same as the domain.");
            }

            let isolatedUser = String(b.isolated_user || "").trim().toLowerCase();
            if (!isolatedUser && domain) {
                isolatedUser = domain.split(".")[0].replace(/[^a-z0-9_-]/g, "").replace(/^[^a-z]+/, "");
            }
            if (!USER.test(isolatedUser) || RESERVED_USERS.includes(isolatedUser)) {
                fail("isolated_user", "Use 1–32 lowercase letters, digits, - or _, starting with a letter (not a reserved name).");
            }

            let phpVersion = "";
            if (PHP_TYPES.includes(type)) {
                phpVersion = String(b.php_version || "");
                if (!PHP_VERSIONS.includes(phpVersion)) fail("php_version", "Choose a valid PHP version.");
            }

            let port = 0;
            if (NODE_TYPES.includes(type)) {
                const rawPort = String(b.port ?? "").trim();
                if (rawPort === "" || rawPort === "0") {
                    const used = new Set(onServer.map((s) => Number(s.port)));
                    port = 3000;
                    while (used.has(port)) port++;
                } else {
                    port = Number(rawPort);
                    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
                        fail("port", "The app port must be between 1024 and 65535.");
                    }
                }
            }

            const sourceControlId = Number(b.source_control_id) || 0;
            let repository = "";
            let branch = "";
            if (sourceControlId !== 0) {
                const sc = (await SourceProvider.find(sourceControlId)) as
                    | { user_id: number; team_id?: number | null }
                    | null;
                if (!sc || (await teamIdOfRow(sc)) !== teamId) {
                    fail("source_control_id", "Source control connection not found.");
                }

                repository = String(b.repository || "").trim();
                if (!REPO.test(repository)) fail("repository", "Use the owner/repository format.");

                branch = String(b.branch || "").trim() || "main";
                if (!BRANCH.test(branch) || branch.includes("..")) fail("branch", "That branch name isn't valid.");
            }

            const webDirectory = String(b.web_directory || "").trim().replace(/^\/+|\/+$/g, "");
            if (webDirectory && (!/^[A-Za-z0-9._\/-]+$/.test(webDirectory) || webDirectory.split("/").includes(".."))) {
                fail("web_directory", "Use a relative path like public or dist.");
            }

            // Uniqueness on this server.
            if (Object.keys(errors).length === 0) {
                if (onServer.some((s) => s.domain === domain)) {
                    fail("domain", "That domain already exists on this server.");
                }
                if (onServer.some((s) => s.isolated_user === isolatedUser)) {
                    fail("isolated_user", "That isolated user is already used on this server.");
                }
                // Every app type that listens on a port, not just "nodejs".
                if (NODE_TYPES.includes(type) && onServer.some((s) => NODE_TYPES.includes(s.type) && Number(s.port) === port)) {
                    fail("port", "That port is already used by another site on this server.");
                }
            }

            if (Object.keys(errors).length > 0) {
                res.status(422);
                return res.json({ errors });
            }

            // After every cheap refusal, before the row is created.
            if (!createGuardPerTeam(req as any, res as any)) return;

            // Last check before the row is created. The row exists straight away
            // (status "pending"), so two quick requests can't both slip under the limit.
            if (!(await requireWithin(res as any, teamId, "sites"))) return;

            const row = (await Site.create({
                user_id: req.user?.userId,
                team_id: teamId,
                server_id: server.id,
                type,
                domain,
                aliases: JSON.stringify(aliases),
                isolated_user: isolatedUser,
                php_version: phpVersion,
                port,
                source_control_id: sourceControlId,
                repository,
                branch,
                web_directory: webDirectory,
                install_deps: sourceControlId !== 0 && b.install_deps !== false ? 1 : 0,
                status: "pending",
                step: "pending",
                error: "",
                log: "",
            })) as SiteRow;

            await dispatch("CreateSite", { siteId: row.id });

            await audit({
                userId: Number(req.user?.userId),
                teamId,
                serverId: server.id,
                event: "site.created",
                level: "success",
                message: `Site ${row.domain} was created.`,
                meta: { site_id: row.id, type: row.type, repository: row.repository || null },
            });

            res.status(202);
            return res.json(present(row));
        }),
    );
}