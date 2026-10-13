/**
 * Feature: Site (owner-scoped)
 *
 * A site belongs to a server, and the server must belong to the caller.
 * Anything not owned answers 404, never 403. store() saves the row as
 * "pending", starts the provisioner in the background, and returns right
 * away so the browser can go to the site details page and watch progress.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { validateSite, normalizeSite } from "../validators/SiteValidator.js";
import type { NormalizedSite } from "../validators/SiteValidator.js";
import { SiteProvisioner } from "../services/SiteProvisioner.js";
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
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

function parseAliases(raw: unknown): string[] {
    try {
        const value = JSON.parse(String(raw || "[]"));
        return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    } catch {
        return [];
    }
}

/** The log can get big, so only the details endpoint sends it. */
function toPublic(row: SiteRow, withLog = false) {
    const { log, aliases, ...rest } = row;
    return {
        ...rest,
        aliases: parseAliases(aliases),
        install_deps: Boolean(rest.install_deps),
        ...(withLog ? { log: String(log ?? "") } : {}),
    };
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
        })) as SiteRow | null;

        if (!site) {
            res.status(500);
            return res.json({ error: "Could not save the site." });
        }

        SiteProvisioner.start(site.id);

        res.status(201);
        return res.json(toPublic(site));
    }

    // Editing and deleting need server-side cleanup (vhost, pool, service,
    // files), so they come in a later step. The stubs keep the routes safe.
    async update(_req: TylixRequest, res: TylixResponse) {
        res.status(501);
        return res.json({ error: "Editing sites isn't supported yet." });
    }

    async destroy(_req: TylixRequest, res: TylixResponse) {
        res.status(501);
        return res.json({ error: "Deleting sites isn't supported yet." });
    }
}