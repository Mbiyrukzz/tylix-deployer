/**
 * Feature: Site (owner-scoped)
 *
 * A site belongs to a server, and the server must belong to the caller.
 * Anything not owned answers 404, never 403. store() saves the row as
 * "pending", starts the provisioner in the background, and returns right
 * away so the browser can go to the site details page and watch progress.
 *
 * Deployment: the env is stored encrypted and only returned by
 * deployment(). deploy() starts SiteDeployer in the background.
 *
 * Deleting: destroy() needs ?confirm=<domain> (the API enforces the typed
 * confirmation, not just the UI), marks the site "deleting" and starts
 * SiteDestroyer in the background. ?force=1 skips server cleanup.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { Deployment } from "../models/Deployment.js";
import { Server } from "../models/Server.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { validateSite, normalizeSite } from "../validators/SiteValidator.js";
import type { NormalizedSite } from "../validators/SiteValidator.js";
import { SiteProvisioner } from "../services/SiteProvisioner.js";
import { SiteDeployer, canDeploy, defaultDeployScript, envPathFor } from "../services/SiteDeployer.js";
import { SiteDestroyer } from "../services/SiteDestroyer.js";
import { CryptoService } from "../services/CryptoService.js";
import { needsPort } from "../services/SiteTypes.js";

interface SiteRow {
    id: number;
    user_id: number;
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
    status: string;
    log: string;
    branch: string;
    started_at: string;
    finished_at: string;
    created_at: string;
    [key: string]: unknown;
}

async function deploymentsFor(siteId: number): Promise<DeploymentRow[]> {
    const all = (await Deployment.all()) as DeploymentRow[];
    return all.filter((d) => Number(d.site_id) === Number(siteId)).sort((a, b) => Number(b.id) - Number(a.id));
}

/**
 * SiteDeployer only writes to the site row, so history rows are closed here.
 * The newest running row takes the site's result; any older running row was
 * interrupted (restart, stale deploy) and is marked failed.
 */
async function syncDeployments(site: SiteRow): Promise<DeploymentRow[]> {
    const rows = await deploymentsFor(site.id);
    const running = rows.filter((d) => d.status === "deploying");
    let changed = false;

    for (let i = 0; i < running.length; i++) {
        const d = running[i];

        if (i === 0) {
            if (site.deploy_status === "deploying") continue;

            await Deployment.update(d.id, {
                status: site.deploy_status === "success" ? "success" : "failed",
                log: String(site.deploy_log ?? ""),
                finished_at: String(site.deployed_at || new Date().toISOString()),
            });
        } else {
            await Deployment.update(d.id, {
                status: "failed",
                log: String(d.log || "") || "Interrupted before it finished.",
                finished_at: new Date().toISOString(),
            });
        }

        changed = true;
    }

    return changed ? await deploymentsFor(site.id) : rows;
}

function toPublicDeployment(row: DeploymentRow) {
    const { log, user_id, ...rest } = row;
    return rest;
}

const MAX_TEXT = 20_000;
const STALE_DEPLOY_MS = 30 * 60_000;
const STALE_DELETE_MS = 10 * 60_000;

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

async function findOwned(req: TylixRequest, res: TylixResponse): Promise<SiteRow | null> {
    const site = (await Site.find(req.params.id)) as SiteRow | null;

    if (!site || site.user_id !== req.user?.userId) {
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
        const sites = (await Site.all()) as SiteRow[];
        const own = sites
            .filter((s) => s.user_id === req.user?.userId)
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return res.json(own.map((s) => toPublic(s)));
    }

    async show(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

        return res.json(toPublic(site, true));
    }

    async store(req: TylixRequest, res: TylixResponse) {
        const result = validateSite(req.body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeSite(req.body);

        const server = (await Server.find(input.server_id)) as { user_id: number } | null;
        if (!server || server.user_id !== req.user?.userId) {
            res.status(404);
            return res.json({ error: "Server not found." });
        }

        if (input.source_control_id !== 0) {
            const sc = (await SourceProvider.find(input.source_control_id)) as { user_id: number } | null;

            if (!sc || sc.user_id !== req.user?.userId) {
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

        const site = (await Site.create({
            user_id: req.user?.userId,
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

        res.status(201);
        return res.json(toPublic(site));
    }

    // Editing needs server-side changes (vhost, pool, service), so it comes in a later step.
    async update(_req: TylixRequest, res: TylixResponse) {
        res.status(501);
        return res.json({ error: "Editing sites isn't supported yet." });
    }

    /**
     * DELETE /api/sites/:id?confirm=<domain>[&force=1]
     *
     * Marks the site "deleting" and cleans up in the background. The page polls
     * GET /api/sites/:id until it answers 404 (gone) or status "delete_failed".
     */
    async destroy(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

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

        const age = Date.now() - new Date(site.updated_at).getTime();

        const creating = site.status === "pending" || site.status === "creating";
        const deploying = site.deploy_status === "deploying";
        const alreadyDeleting = site.status === "deleting";

        if ((creating || deploying) && age < STALE_DEPLOY_MS) {
            res.status(409);
            return res.json({ error: "This site is busy creating or deploying. Wait for it to finish, then try again." });
        }

        if (alreadyDeleting && age < STALE_DELETE_MS) {
            res.status(409);
            return res.json({ error: "This site is already being deleted." });
        }

        await Site.update(site.id, { status: "deleting", step: "del_services", error: "" });
        SiteDestroyer.start(site.id, force);

        res.status(202);
        return res.json({ status: "deleting" });
    }

    // ---- deployment ----

    /** GET /api/sites/:id/deployment: script, env, status and log for the Deployment tab. */
    async deployment(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

        const defaultScript = defaultDeployScript(site);

        return res.json({
            can_deploy: canDeploy(site),
            deploy_script: String(site.deploy_script || "") || defaultScript,
            default_script: defaultScript,
            env: readEnv(site),
            env_path: envPathFor(site),
            deploy_status: String(site.deploy_status || "idle"),
            deploy_log: String(site.deploy_log ?? ""),
            deployed_at: String(site.deployed_at ?? ""),
        });
    }

        /** GET /api/sites/:id/deployments: newest first, without logs. */
    async deployments(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

        const rows = await syncDeployments(site);
        return res.json(rows.slice(0, 50).map(toPublicDeployment));
    }

    /** GET /api/sites/:id/deployments/:deploymentId: one deployment's log. */
    async deploymentLog(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

        await syncDeployments(site);

        const row = (await Deployment.find(req.params.deploymentId)) as DeploymentRow | null;
        if (!row || Number(row.site_id) !== Number(site.id)) {
            res.status(404);
            return res.json({ error: "Deployment not found." });
        }

        // A running deployment's log lives on the site row until it finishes.
        const log = row.status === "deploying" ? String(site.deploy_log ?? "") : String(row.log ?? "");

        return res.json({ id: row.id, status: row.status, log });
    }

    /** PUT /api/sites/:id/deployment: body { deploy_script?, env? }. Omitted fields are left alone. */
    async saveDeployment(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

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
        }

        res.status(204);
        return res.end();
    }

    /** POST /api/sites/:id/deploy */
    async deploy(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

        if (site.status !== "ready") {
            res.status(409);
            return res.json({ error: "The site isn't ready yet. Wait for it to finish creating." });
        }

        if (!canDeploy(site)) {
            res.status(422);
            return res.json({ error: "This site has no repository to deploy from." });
        }

        const age = Date.now() - new Date(site.updated_at).getTime();
        if (site.deploy_status === "deploying" && age < STALE_DEPLOY_MS) {
            res.status(409);
            return res.json({ error: "A deployment is already running." });
        }

        await Site.update(site.id, { deploy_status: "deploying", deploy_log: "" });
        await Deployment.create({
            site_id: site.id,
            user_id: site.user_id,
            status: "deploying",
            log: "",
            branch: String(site.branch ?? ""),
            started_at: new Date().toISOString(),
            finished_at: "",
        });
        SiteDeployer.start(site.id);

        res.status(202);
        return res.json({ deploy_status: "deploying" });
    }
}