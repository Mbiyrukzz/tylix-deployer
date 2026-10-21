/**
 * SSL endpoints for a site (team-scoped; a site on another team answers 404).
 * Any team member can see the status; changing it needs the admin role.
 *
 *   show     GET  /api/sites/:id/ssl
 *   enable   POST /api/sites/:id/ssl          { mode: "letsencrypt", email }
 *                                          or { mode: "custom", certificate, private_key }
 *   disable  POST /api/sites/:id/ssl/disable
 *
 * The custom private key is passed to the background job in memory and is
 * never written to the database.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { SiteSsl } from "../services/SiteSsl.js";
import type { SslRequest } from "../services/SiteSsl.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { requireActive } from "../services/EntitlementService.js";

interface SiteRow {
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
    web_directory: string;
    app_directory: string;
    build_command: string;
    status: string;
    ssl_mode: string;
    ssl_status: string;
    ssl_email: string;
    ssl_error: string;
    ssl_log: string;
    ssl_expires_at: string;
    updated_at: string;
    [key: string]: unknown;
}

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const CERT = /-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/;
const KEY = /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]+-----END (?:[A-Z]+ )?PRIVATE KEY-----/;
const MAX_PEM = 16_000;
const STALE_MS = 30 * 60_000;

function parseAliases(raw: unknown): string[] {
    try {
        const value = JSON.parse(String(raw || "[]"));
        return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
    } catch {
        return [];
    }
}

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

/** Answers 409 itself if the site can't take an SSL change right now. */
function guard(site: SiteRow, res: TylixResponse): boolean {
    if (site.status !== "ready") {
        res.status(409);
        res.json({ error: "The site isn't ready yet. Wait for it to finish creating." });
        return false;
    }

    const age = Date.now() - new Date(site.updated_at).getTime();
    if (site.ssl_status === "working" && age < STALE_MS) {
        res.status(409);
        res.json({ error: "An SSL change is already running." });
        return false;
    }

    return true;
}

const pem = (value: unknown) => String(value ?? "").replace(/\r\n/g, "\n").trim();

export class SiteSslController {
    async show(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;

        return res.json({
            mode: String(site.ssl_mode || "none"),
            status: String(site.ssl_status || "idle"),
            email: String(site.ssl_email ?? ""),
            error: String(site.ssl_error ?? ""),
            log: String(site.ssl_log ?? ""),
            expires_at: String(site.ssl_expires_at ?? ""),
            domains: [site.domain, ...parseAliases(site.aliases)],
        });
    }

    async enable(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;
        if (!guard(site, res)) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const mode = String(body.mode ?? "");
        let request: SslRequest;

        if (mode === "letsencrypt") {
            const email = String(body.email ?? "").trim().toLowerCase();
            if (!EMAIL.test(email) || email.length > 254) {
                res.status(422);
                return res.json({ errors: { email: ["Enter a valid email address."] } });
            }
            request = { mode: "letsencrypt", email };
        } else if (mode === "custom") {
            const certificate = pem(body.certificate);
            const privateKey = pem(body.private_key);
            const errors: Record<string, string[]> = {};

            if (!CERT.test(certificate) || certificate.includes("\0")) {
                errors.certificate = ["Paste the full certificate in PEM format, including the BEGIN and END lines."];
            } else if (certificate.length > MAX_PEM) {
                errors.certificate = ["That certificate is too large."];
            }

            if (!KEY.test(privateKey) || privateKey.includes("\0")) {
                errors.private_key = ["Paste the private key in PEM format, including the BEGIN and END lines."];
            } else if (/ENCRYPTED/.test(privateKey)) {
                errors.private_key = ["Passphrase-protected keys aren't supported. Remove the passphrase first."];
            } else if (privateKey.length > MAX_PEM) {
                errors.private_key = ["That key is too large."];
            }

            if (Object.keys(errors).length > 0) {
                res.status(422);
                return res.json({ errors });
            }

            request = { mode: "custom", certificate: certificate + "\n", privateKey: privateKey + "\n" };
        } else {
            res.status(422);
            return res.json({ errors: { mode: ["Choose Let's Encrypt or a custom certificate."] } });
        }

        await Site.update(site.id, { ssl_status: "working", ssl_error: "", ssl_log: "" });
        SiteSsl.start(site.id, request);

        res.status(202);
        return res.json({ status: "working" });
    }

    async disable(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;
        if (!guard(site, res)) return;

        if (String(site.ssl_mode || "none") === "none") {
            res.status(409);
            return res.json({ error: "HTTPS isn't enabled for this site." });
        }

        await Site.update(site.id, { ssl_status: "working", ssl_error: "", ssl_log: "" });
        SiteSsl.start(site.id, { mode: "none" });

        res.status(202);
        return res.json({ status: "working" });
    }
}