/**
 * Feature: Site (team-scoped)
 *
 * A site belongs to a server, and the server must belong to the caller's
 * team. Anything on another team answers 404, never 403. store() saves the
 * row as "pending", starts the provisioner in the background, and returns
 * right away so the browser can go to the site details page and watch
 * progress.
 *
 * Teams: sites belong to a team (team_id). user_id is the person who
 * created the site. Everyone on the team sees it.
 *
 * Plans: creating a site is checked against the team's site limit
 * (EntitlementService). Deleting and deploying are never limited by the
 * plan, but every write (create, delete, deploy, save script/env) is
 * refused with 402 while the team is view only (requireActive).
 *
 * Roles:
 *   - member: view sites, deployments and logs, trigger and cancel a deploy
 *   - admin / owner: also create and delete sites, edit the deploy script,
 *     see and edit the env file, and delete deployment history entries
 * To change who may do what, change the role in the requireRole() call.
 *
 * Deployment: the env is stored encrypted and only returned by
 * deployment() to admins and owners.
 *
 * Deploys are QUEUED. deploy() creates a "queued" history row and returns
 * 202 straight away; the runner in SiteDeployer picks it up. History rows go
 * queued -> deploying -> success | failed | cancelled. cancelDeployment()
 * removes a queued row from the queue, or asks the runner to stop a running
 * one. A cancel is allowed even while the team is view only, so a stuck
 * deploy can always be cleared.
 *
 * The history is paginated (?page, ?per_page, ?status) and each entry carries
 * the commit it deployed, with a link to GitHub or GitLab.
 *
 * Deleting: destroy() needs ?confirm=<domain> (the API enforces the typed
 * confirmation, not just the UI), marks the site "deleting" and starts
 * SiteDestroyer in the background. ?force=1 skips server cleanup.
 * With two-factor on, a valid code (body or query `code`) is also required
 * (requireStepUp: wrong codes are counted and lock the user out). That check
 * runs last, after every check that can refuse the request.
 *
 * Hardening:
 *   - creating is rate limited per team; deleting, deploying, cancelling and
 *     saving the deployment are rate limited per user
 *   - creating, deleting, deploying, cancelling and changing the script or
 *     env are written to the server log (never the script or env contents)
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { Deployment } from "../models/Deployment.js";
import { Server } from "../models/Server.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { validateSite, normalizeSite } from "../validators/SiteValidator.js";
import type { NormalizedSite } from "../validators/SiteValidator.js";
import { SiteProvisioner } from "../services/SiteProvisioner.js";
import { SiteDeployer, canDeploy, defaultDeployScript, envPathFor, parseTime } from "../services/SiteDeployer.js";
import { SiteDestroyer } from "../services/SiteDestroyer.js";
import { CryptoService } from "../services/CryptoService.js";
import { commitUrl } from "../services/CommitLinks.js";
import { needsPort } from "../services/SiteTypes.js";
import { createGuard, audit, requireStepUp } from "../services/RouteGuard.js";
import { requireTeam, requireRole, hasRole } from "../services/TeamScope.js";
import { requireActive, requireWithin } from "../services/EntitlementService.js";

interface SiteRow {
    id: number;
    user_id: number;
    team_id: number | null;
    server_id: number;
    source_control_id: number;
    type: string;
    domain: string;
    aliases: string;
    isolated_user: string;
    php_version: string;
    port: number;
    repository: string;
    branch: string;
    web_directory: string;
    app_directory: string;
    backend_directory: string;
    build_command: string;
    start_command: string;
    install_deps: number | boolean;
    status: string;
    step: string;
    error: string;
    log: string;
    deploy_script: string;
    env_content: string;
    deploy_status: string;
    deploy_log: string;
    deployed_at: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

interface DeploymentRow {
    id: number;
    site_id: number;
    user_id: number;
    team_id: number | null;
    status: string;
    log: string;
    branch: string;
    commit_sha: string;
    commit_message: string;
    cancel_requested: number;
    runner: string;
    queued_at: string;
    started_at: string;
    finished_at: string;
    heartbeat_at: string;
    created_at: string;
    [key: string]: unknown;
}

const FIFTEEN_MINUTES = 15 * 60_000;
const createGuardPerTeam = createGuard({ max: 20, windowMs: 60 * 60_000, scope: "team", what: "site creations" });
const deleteGuard = createGuard({ max: 10, windowMs: FIFTEEN_MINUTES, scope: "user", what: "site deletions" });
const deployGuard = createGuard({ max: 15, windowMs: FIFTEEN_MINUTES, scope: "user", what: "deployments" });
const cancelGuard = createGuard({ max: 30, windowMs: FIFTEEN_MINUTES, scope: "user", what: "deployment cancellations" });
const saveGuard = createGuard({ max: 30, windowMs: FIFTEEN_MINUTES, scope: "user", what: "deployment changes" });
const deleteDeploymentGuard = createGuard({ max: 60, windowMs: FIFTEEN_MINUTES, scope: "user", what: "deployment deletions" });

const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE = 50;

const MAX_TEXT = 20_000;
const STALE_CREATE_MS = 30 * 60_000; // site creation has no heartbeat
const STALE_DELETE_MS = 10 * 60_000;
const DEAD_RUNNER_MS = 45_000; // a running deploy silent this long has no live runner

async function deploymentsFor(siteId: number): Promise<DeploymentRow[]> {
    const all = (await Deployment.all()) as DeploymentRow[];
    return all.filter((d) => Number(d.site_id) === Number(siteId)).sort((a, b) => Number(b.id) - Number(a.id));
}

/** Queued deployments across all sites, oldest first (the runner takes them in this order). */
async function queuedAll(): Promise<DeploymentRow[]> {
    const rows = (await Deployment.where("status", "queued").get()) as unknown as DeploymentRow[];
    return rows.sort((a, b) => Number(a.id) - Number(b.id));
}

/** The log and the person who deployed stay private; the commit is exposed as commit, commit_message and commit_url. */
function toPublicDeployment(row: DeploymentRow, repository: string, kind: string, position = 0) {
    const { log, user_id, commit_sha, commit_message, runner, heartbeat_at, cancel_requested, ...rest } = row;
    const sha = String(commit_sha ?? "");

    return {
        ...rest,
        commit: sha,
        commit_message: String(commit_message ?? ""),
        commit_url: commitUrl(repository, kind, sha),
        cancelling: Number(cancel_requested) === 1 && (row.status === "queued" || row.status === "deploying"),
        position,
    };
}

/** "github" or "gitlab" for the site's source control connection ("" when there is none). */
async function sourceKindOf(site: SiteRow): Promise<string> {
    if (Number(site.source_control_id) === 0) return "";

    try {
        const sc = (await SourceProvider.find(site.source_control_id)) as { kind?: string } | null;
        return String(sc?.kind ?? "");
    } catch {
        return "";
    }
}

function intParam(value: unknown, fallback: number, min: number, max: number): number {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function parseAliases(raw: unknown): string[] {
    try {
        const value = JSON.parse(String(raw || "[]"));
        return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    } catch {
        return [];
    }
}

/** The log can get big, so only the details endpoint sends it. Secrets never leave here. */
function toPublic(row: SiteRow, withLog = false) {
    const { log, aliases, env_content, deploy_script, deploy_log, ...rest } = row;
    return {
        ...rest,
        aliases: parseAliases(aliases),
        install_deps: Boolean(rest.install_deps),
        deploy_status: String(rest.deploy_status || "idle"),
        ...(withLog ? { log: String(log ?? "") } : {}),
    };
}

function readEnv(row: SiteRow): string {
    if (!row.env_content) return "";
    try {
        return CryptoService.decrypt(String(row.env_content));
    } catch {
        return "";
    }
}

/** Loads a site and answers 404 itself if it is missing or not on the caller's team. */
async function findOwned(req: TylixRequest, res: TylixResponse): Promise<SiteRow | null> {
    const teamId = requireTeam(req, res);
    if (!teamId) return null;

    const site = (await Site.find(req.params.id)) as SiteRow | null;

    if (!site || Number(site.team_id) !== teamId) {
        res.status(404);
        res.json({ error: "Site not found." });
        return null;
    }

    return site;
}

async function sitesOnServer(serverId: number): Promise<SiteRow[]> {
    // Same all() + filter approach as ServerController; fine for small tables.
    const sites = (await Site.all()) as SiteRow[];
    return sites.filter((s) => Number(s.server_id) === serverId);
}

async function nextFreePort(serverId: number): Promise<number> {
    const used = new Set((await sitesOnServer(serverId)).map((s) => Number(s.port)));
    let port = 3000;
    while (used.has(port)) port++;
    return port;
}

async function findConflict(input: NormalizedSite): Promise<string | null> {
    const onServer = await sitesOnServer(input.server_id);

    if (onServer.some((s) => s.domain === input.domain)) {
        return "A site with that domain already exists on this server.";
    }

    if (onServer.some((s) => s.isolated_user === input.isolated_user)) {
        return `The isolated user "${input.isolated_user}" is already used on this server. Pick another.`;
    }

    if (needsPort(input.type) && onServer.some((s) => needsPort(s.type) && Number(s.port) === input.port)) {
        return `Port ${input.port} is already used by another app on this server.`;
    }

    return null;
}

export class SiteController {
    async index(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;

        const sites = (await Site.all()) as SiteRow[];
        const own = sites
            .filter((s) => Number(s.team_id) === teamId)
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return res.json(own.map((s) => toPublic(s)));
    }

    async show(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

        return res.json(toPublic(site, true));
    }

    /** Admin only. Refused while the team is view only. Limited by the team's plan. */
    async store(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, teamId))) return;

        const result = validateSite(req.body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeSite(req.body);

        const server = (await Server.find(input.server_id)) as { team_id: number | null } | null;
        if (!server || Number(server.team_id) !== teamId) {
            res.status(404);
            return res.json({ error: "Server not found." });
        }

        if (input.source_control_id !== 0) {
            const sc = (await SourceProvider.find(input.source_control_id)) as { team_id: number | null } | null;

            if (!sc || Number(sc.team_id) !== teamId) {
                res.status(422);
                return res.json({ errors: { source_control_id: ["Source control not found."] } });
            }
        }

        if (needsPort(input.type) && input.port === 0) {
            input.port = await nextFreePort(input.server_id);
        }

        const conflict = await findConflict(input);
        if (conflict) {
            res.status(409);
            return res.json({ error: conflict });
        }

        // After every cheap refusal, before the row is created.
        if (!createGuardPerTeam(req, res)) return;

        // Last check before the row is created. The site row exists straight away
        // (status "pending"), so two quick requests can't both slip under the limit.
        if (!(await requireWithin(res, teamId, "sites"))) return;

        const site = (await Site.create({
            user_id: req.user?.userId,
            team_id: teamId,
            server_id: input.server_id,
            source_control_id: input.source_control_id,
            type: input.type,
            domain: input.domain,
            aliases: JSON.stringify(input.aliases),
            isolated_user: input.isolated_user,
            php_version: input.php_version,
            port: input.port,
            repository: input.repository,
            branch: input.branch,
            web_directory: input.web_directory,
            app_directory: input.app_directory,
            backend_directory: input.backend_directory,
            build_command: input.build_command,
            start_command: input.start_command,
            install_deps: input.install_deps ? 1 : 0,
            status: "pending",
            step: "pending",
            error: "",
            log: "",
            deploy_script: "",
            env_content: "",
            deploy_status: "idle",
            deploy_log: "",
            deployed_at: "",
        })) as SiteRow | null;

        if (!site) {
            res.status(500);
            return res.json({ error: "Could not save the site." });
        }

        SiteProvisioner.start(site.id);

        await audit({
            userId: Number(req.user?.userId),
            teamId,
            serverId: site.server_id,
            event: "site.created",
            level: "success",
            message: `Site ${site.domain} was created.`,
            meta: { site_id: site.id, type: site.type, repository: site.repository || null },
        });

        res.status(201);
        return res.json(toPublic(site));
    }

    // Editing needs server-side changes (vhost, pool, service), so it comes in a later step.
    // When it is built, add requireActive here like the other writes.
    async update(_req: TylixRequest, res: TylixResponse) {
        res.status(501);
        return res.json({ error: "Editing sites isn't supported yet." });
    }

    /**
     * DELETE /api/sites/:id?confirm=<domain>[&force=1][&code=<2fa code>]
     *
     * Marks the site "deleting" and cleans up in the background. The page polls
     * GET /api/sites/:id until it answers 404 (gone) or status "delete_failed".
     * Refused while the team is view only. With two-factor on, a valid code is
     * required.
     */
    async destroy(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(site.team_id)))) return;
        if (!deleteGuard(req, res)) return;

        const query = (req as { query?: Record<string, unknown> }).query ?? {};
        const confirm = String(query.confirm ?? "");
        const force = query.force === "1" || query.force === "true";

        if (confirm !== site.domain) {
            res.status(422);
            return res.json({
                error: "Type the site's domain exactly to confirm.",
                errors: { confirm: ["Type the site's domain exactly to confirm."] },
            });
        }

        // Settle anything whose process died, so a dead deploy can't block the delete.
        await SiteDeployer.sweepStale();
        const fresh = ((await Site.find(site.id)) as SiteRow | null) ?? site;

        const age = Date.now() - new Date(fresh.updated_at).getTime();

        const creating = fresh.status === "pending" || fresh.status === "creating";
        const deploying = fresh.deploy_status === "deploying" || fresh.deploy_status === "queued";
        const alreadyDeleting = fresh.status === "deleting";

        if (creating && age < STALE_CREATE_MS) {
            res.status(409);
            return res.json({ error: "This site is busy creating. Wait for it to finish, then try again." });
        }

        if (deploying) {
            res.status(409);
            return res.json({ error: "This site has a deployment queued or running. Cancel it first, then try again." });
        }

        if (alreadyDeleting && age < STALE_DELETE_MS) {
            res.status(409);
            return res.json({ error: "This site is already being deleted." });
        }

        // Last gate before the irreversible step: second factor, if the caller has one on.
        if (!(await requireStepUp(req, res, "delete this site"))) return;

        await Site.update(site.id, { status: "deleting", step: "del_services", error: "" });
        SiteDestroyer.start(site.id, force);

        await audit({
            userId: Number(req.user?.userId),
            teamId: Number(site.team_id),
            serverId: site.server_id,
            event: "site.delete_started",
            level: "warning",
            message: force
                ? `Deleting ${site.domain} (server cleanup skipped).`
                : `Deleting ${site.domain}.`,
            meta: { site_id: site.id, force },
        });

        res.status(202);
        return res.json({ status: "deleting" });
    }

    // ---- deployment ----

    /**
     * GET /api/sites/:id/deployment: script, env, status and log for the Deployment tab.
     * Plain members get env "" and env_hidden true: env files hold production secrets.
     *
     * `active` describes the queued or running deployment (null when there is none),
     * and idle_seconds says how long a running one has been silent.
     */
    async deployment(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

        const defaultScript = defaultDeployScript(site);
        const canSeeEnv = hasRole(req, "admin");

        const newest = (await Deployment.where("site_id", site.id).orderBy("id", "DESC").limit(1).get()) as unknown as DeploymentRow[];
        const latest = newest[0] ?? null;
        const live = latest && (latest.status === "queued" || latest.status === "deploying") ? latest : null;

        let position = 0;
        if (live && live.status === "queued") {
            const queue = await queuedAll();
            position = queue.findIndex((d) => Number(d.id) === Number(live.id)) + 1;
        }

        let idleSeconds = 0;
        if (live && live.status === "deploying") {
            const beat = parseTime(live.heartbeat_at) || parseTime(live.started_at);
            if (Number.isFinite(beat)) idleSeconds = Math.max(0, Math.round((Date.now() - beat) / 1000));
        }

        let queuedSeconds = 0;
        if (live && live.status === "queued") {
            const at = parseTime(live.queued_at);
            if (Number.isFinite(at)) queuedSeconds = Math.max(0, Math.round((Date.now() - at) / 1000));
        }

        return res.json({
            queued_seconds: queuedSeconds,
            can_deploy: canDeploy(site),
            deploy_script: String(site.deploy_script || "") || defaultScript,
            default_script: defaultScript,
            env: canSeeEnv ? readEnv(site) : "",
            env_hidden: !canSeeEnv,
            env_path: envPathFor(site),
            deploy_status: String(site.deploy_status || "idle"),
            deploy_log: String(site.deploy_log ?? ""),
            deployed_at: String(site.deployed_at ?? ""),
            idle_seconds: idleSeconds,
            active: live
                ? {
                      id: live.id,
                      status: live.status,
                      cancelling: Number(live.cancel_requested) === 1,
                      position,
                      queued_at: String(live.queued_at ?? ""),
                      started_at: String(live.started_at ?? ""),
                  }
                : null,
        });
    }

    /**
     * GET /api/sites/:id/deployments?page=1&per_page=10&status=all|success|failed|cancelled
     *
     * Newest first, without logs. The counts always cover the whole history
     * (not just the chosen status), so the filter tabs can show them.
     * active_id is the newest successful deployment. `source` is "github" or
     * "gitlab" (for commit links).
     */
    async deployments(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

        // Settle deployments whose process died, so the list is never stuck on "deploying".
        await SiteDeployer.sweepStale();
        const rows = await deploymentsFor(site.id);

        const query = (req as { query?: Record<string, unknown> }).query ?? {};
        const perPage = intParam(query.per_page, DEFAULT_PER_PAGE, 1, MAX_PER_PAGE);
        const wanted = String(query.status ?? "all");
        const status = wanted === "success" || wanted === "failed" || wanted === "cancelled" ? wanted : "all";

        const counts = {
            all: rows.length,
            success: rows.filter((d) => d.status === "success").length,
            failed: rows.filter((d) => d.status === "failed").length,
            cancelled: rows.filter((d) => d.status === "cancelled").length,
        };

        const filtered = status === "all" ? rows : rows.filter((d) => d.status === status);
        const total = filtered.length;
        const totalPages = Math.ceil(total / perPage);
        const page = intParam(query.page, 1, 1, Math.max(1, totalPages));

        const slice = filtered.slice((page - 1) * perPage, page * perPage);
        const activeId = rows.find((d) => d.status === "success")?.id ?? null;

        const kind = await sourceKindOf(site);
        const repository = String(site.repository ?? "");

        // Queue positions are global (the runner takes queued rows oldest first).
        const queue = slice.some((d) => d.status === "queued") ? await queuedAll() : [];
        const positionOf = (id: number) => queue.findIndex((d) => Number(d.id) === Number(id)) + 1;

        return res.json({
            data: slice.map((d) => toPublicDeployment(d, repository, kind, d.status === "queued" ? positionOf(d.id) : 0)),
            page,
            per_page: perPage,
            total,
            total_pages: totalPages,
            counts,
            active_id: activeId,
            source: kind,
        });
    }

    /** GET /api/sites/:id/deployments/:deploymentId: one deployment's log. */
    async deploymentLog(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

        const row = (await Deployment.find(req.params.deploymentId)) as DeploymentRow | null;
        if (!row || Number(row.site_id) !== Number(site.id)) {
            res.status(404);
            return res.json({ error: "Deployment not found." });
        }

        // A running deployment saves its log on its own row as it goes; the site row
        // carries the same text, which is the fallback for older rows.
        const log =
            row.status === "deploying" ? String(row.log || site.deploy_log || "") : String(row.log ?? "");

        return res.json({ id: row.id, status: row.status, log });
    }

    /**
     * DELETE /api/sites/:id/deployments/:deploymentId: removes one history entry
     * and its log. Admin only. Refused while that deployment is queued or
     * running (cancel it first). Nothing changes on the server.
     */
    async deleteDeployment(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(site.team_id)))) return;
        if (!deleteDeploymentGuard(req, res)) return;

        // Close rows whose process died first, so they can be deleted.
        await SiteDeployer.sweepStale();

        const row = (await Deployment.find(req.params.deploymentId)) as DeploymentRow | null;
        if (!row || Number(row.site_id) !== Number(site.id)) {
            res.status(404);
            return res.json({ error: "Deployment not found." });
        }

        if (row.status === "deploying" || row.status === "queued") {
            res.status(409);
            return res.json({ error: "This deployment is queued or running. Cancel it first, then delete it." });
        }

        // If your ORM names its delete method differently (destroy, remove), change this line.
        await Deployment.delete(row.id);

        await audit({
            userId: Number(req.user?.userId),
            teamId: Number(site.team_id),
            serverId: site.server_id,
            event: "site.deployment_deleted",
            message: `A deployment of ${site.domain} was removed from the history.`,
            meta: { site_id: site.id, deployment_id: row.id, status: row.status },
        });

        res.status(204);
        return res.end();
    }

    /** PUT /api/sites/:id/deployment: body { deploy_script?, env? }. Omitted fields are left alone. */
    async saveDeployment(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(site.team_id)))) return;
        if (!saveGuard(req, res)) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const errors: Record<string, string[]> = {};
        const patch: Record<string, unknown> = {};

        const check = (field: string, label: string): string | null => {
            const raw = body[field];
            if (raw === undefined) return null;
            if (typeof raw !== "string") {
                errors[field] = [`${label} must be text.`];
                return null;
            }
            const value = raw.replace(/\r\n/g, "\n");
            if (value.includes("\0")) {
                errors[field] = [`${label} contains an invalid character.`];
                return null;
            }
            if (value.length > MAX_TEXT) {
                errors[field] = [`${label} is too long (max ${MAX_TEXT} characters).`];
                return null;
            }
            return value;
        };

        const script = check("deploy_script", "The deployment script");
        const env = check("env", "The environment");

        if (Object.keys(errors).length > 0) {
            res.status(422);
            return res.json({ errors });
        }

        if (script !== null) {
            // Saving the untouched default stores nothing, so later default improvements still apply.
            patch.deploy_script = script.trim() === defaultDeployScript(site).trim() ? "" : script;
        }
        if (env !== null) {
            patch.env_content = env.trim() === "" ? "" : CryptoService.encrypt(env);
        }

        if (Object.keys(patch).length > 0) {
            await Site.update(site.id, patch);

            // Only that something changed is logged, never the script or env itself.
            const changed = [
                ...(script !== null ? ["deploy_script"] : []),
                ...(env !== null ? ["env"] : []),
            ];

            await audit({
                userId: Number(req.user?.userId),
                teamId: Number(site.team_id),
                serverId: site.server_id,
                event: "site.deployment_saved",
                level: "warning",
                message: `The ${changed.join(" and ")} of ${site.domain} ${changed.length === 1 ? "was" : "were"} changed.`,
                meta: { site_id: site.id, fields: changed },
            });
        }

        res.status(204);
        return res.end();
    }

    /**
     * POST /api/sites/:id/deploy: any team member may deploy, unless the team is view only.
     * Queues the deployment and answers 202 right away; the runner starts it.
     */
    async deploy(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;
        if (!(await requireActive(res, Number(site.team_id)))) return;

        if (site.status !== "ready") {
            res.status(409);
            return res.json({ error: "The site isn't ready yet. Wait for it to finish creating." });
        }

        if (!canDeploy(site)) {
            res.status(422);
            return res.json({ error: "This site has no repository to deploy from." });
        }

        // Settle anything whose process died first, so a dead deploy never blocks a new one.
        await SiteDeployer.sweepStale();

        const rows = await deploymentsFor(site.id);
        if (rows.some((d) => d.status === "queued" || d.status === "deploying")) {
            res.status(409);
            return res.json({ error: "A deployment is already queued or running. Cancel it, or wait for it to finish." });
        }

        if (!deployGuard(req, res)) return;

        // The person who pressed Deploy, not the site's creator.
        const queued = await SiteDeployer.enqueue(site.id, Number(req.user?.userId));
        if (!queued) {
            res.status(500);
            return res.json({ error: "Couldn't queue the deployment." });
        }

        await audit({
            userId: Number(req.user?.userId),
            teamId: Number(site.team_id),
            serverId: site.server_id,
            event: "site.deploy_started",
            message: `A deployment of ${site.domain} was queued.`,
            meta: { site_id: site.id, deployment_id: queued.id, branch: String(site.branch ?? "") },
        });

        res.status(202);
        return res.json({ deploy_status: "queued", deployment_id: queued.id });
    }

    /**
     * POST /api/sites/:id/deployments/:deploymentId/cancel
     *
     * Any team member. Allowed even while the team is view only.
     *   - queued: closed straight away as "cancelled"
     *   - running: flagged; the runner stops the running commands within a few
     *     seconds and the deploy script rolls back on its own. If the process
     *     that was running it is gone, it is closed right away instead.
     */
    async cancelDeployment(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;
        if (!cancelGuard(req, res)) return;

        const row = (await Deployment.find(req.params.deploymentId)) as DeploymentRow | null;
        if (!row || Number(row.site_id) !== Number(site.id)) {
            res.status(404);
            return res.json({ error: "Deployment not found." });
        }

        if (row.status !== "queued" && row.status !== "deploying") {
            res.status(409);
            return res.json({ error: "This deployment has already finished." });
        }

        // Flag first: if the runner claims a queued row at this very moment, it sees the flag.
        await Deployment.update(row.id, { cancel_requested: 1 });

        let result: "cancelled" | "cancelling" = "cancelling";

        const current = (await Deployment.find(row.id)) as DeploymentRow | null;

        if (current?.status === "queued") {
            const closed = await SiteDeployer.closeOrphan(
                row.id,
                "cancelled",
                "CANCELLED: removed from the queue before it started.",
                ["queued"],
            );
            if (closed) result = "cancelled";
        } else if (current?.status === "deploying") {
            const beat = parseTime(current.heartbeat_at) || parseTime(current.started_at);
            const silent = Number.isFinite(beat) ? Date.now() - beat : 0;

            if (silent > DEAD_RUNNER_MS) {
                const closed = await SiteDeployer.closeOrphan(
                    row.id,
                    "cancelled",
                    "CANCELLED: the process running this deployment was gone, so it was closed.",
                    ["deploying"],
                );
                if (closed) result = "cancelled";
            }
        }

        await audit({
            userId: Number(req.user?.userId),
            teamId: Number(site.team_id),
            serverId: site.server_id,
            event: "site.deploy_cancelled",
            level: "warning",
            message: `A deployment of ${site.domain} was cancelled.`,
            meta: { site_id: site.id, deployment_id: row.id, was: row.status },
        });

        res.status(202);
        return res.json({ status: result });
    }
}