/**
 * Feature: Site commands (owner-scoped)
 *
 * A site that isn't the caller's answers 404, never 403. Commands can only be
 * run once the site is "ready". run() returns 202 right away and the work
 * continues in the background; the page polls GET /api/sites/:id/commands.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { ServerLogService } from "../services/ServerLogService.js";
import { SiteCommands, MAX_COMMAND_CHARS } from "../services/SiteCommands.js";

interface SiteRow {
    id: number;
    user_id: number;
    server_id: number;
    domain: string;
    isolated_user: string;
    status: string;
    [key: string]: unknown;
}

const DIR = /^[A-Za-z0-9._\/-]+$/;

async function findOwnedSite(req: TylixRequest, res: TylixResponse): Promise<SiteRow | null> {
    const site = (await Site.find(req.params.id)) as SiteRow | null;

    if (!site || site.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Site not found." });
        return null;
    }

    return site;
}

function toPublic(run: ReturnType<typeof SiteCommands.list>[number]) {
    const { user_id, site_id, ...rest } = run;
    return rest;
}

export class SiteCommandController {
    /** GET /api/sites/:id/commands: recent runs, newest first, with output. */
    async index(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;

        return res.json(SiteCommands.list(site.id).map(toPublic));
    }

    /** POST /api/sites/:id/commands   body { command, directory? } */
    async run(req: TylixRequest, res: TylixResponse) {
        const site = await findOwnedSite(req, res);
        if (!site) return;

        if (site.status !== "ready") {
            res.status(409);
            return res.json({ error: "Commands can be run once the site has finished creating." });
        }

        const body = (req.body ?? {}) as Record<string, unknown>;

        if (typeof body.command !== "string") {
            res.status(422);
            return res.json({ error: "The command must be text." });
        }

        const command = body.command.replace(/\r\n/g, "\n").trim();

        if (command === "") {
            res.status(422);
            return res.json({ error: "Type a command first." });
        }
        if (command.includes("\0")) {
            res.status(422);
            return res.json({ error: "The command contains an invalid character." });
        }
        if (command.length > MAX_COMMAND_CHARS) {
            res.status(422);
            return res.json({ error: `The command is too long (max ${MAX_COMMAND_CHARS} characters).` });
        }

        const directory = String(body.directory ?? "").trim().replace(/^\/+|\/+$/g, "");
        if (directory !== "" && (!DIR.test(directory) || directory.split("/").some((p) => p === ".." || p === "."))) {
            res.status(422);
            return res.json({ error: "Use a relative folder like client or public." });
        }

        if (SiteCommands.isBusy(site.id)) {
            res.status(409);
            return res.json({ error: "A command is still running on this site. Wait for it to finish." });
        }

        const run = SiteCommands.start(site, site.user_id, command, directory);

        await ServerLogService.record({
            userId: site.user_id,
            serverId: site.server_id,
            event: "site.command_run",
            message: `Ran a command on ${site.domain}: ${command.split("\n")[0].slice(0, 120)}`,
            meta: { site_id: site.id, directory },
        });

        res.status(202);
        return res.json(toPublic(run));
    }
}