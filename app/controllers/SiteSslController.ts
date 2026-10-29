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
 * never written to the database. It is never written to the server log
 * either: log entries only carry the mode, the domains and the reason.
 *
 * Errors: a refused request answers with a readable `error` (and, for
 * validation, an `errors` map per field) plus a stable `code` the page can
 * switch on. Every refusal and every started change is written to the
 * server log so "why didn't my certificate install?" can be answered later.
 *
 * Custom certificates are checked before anything is sent to the server:
 * they must parse, be inside their validity dates, cover the site's domain,
 * and match the private key.
 */

import { X509Certificate, createPrivateKey } from "node:crypto";
import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Site } from "../models/Site.js";
import { SiteSsl } from "../services/SiteSsl.js";
import type { SslRequest } from "../services/SiteSsl.js";
import { ServerLogService } from "../services/ServerLogService.js";
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

type Level = "success" | "warning";

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
        res.json({ error: "Site not found.", code: "site_not_found" });
        return null;
    }

    return site;
}

/** Writes to the server log. Never throws: a logging problem must not fail the request. */
async function note(
    req: TylixRequest,
    site: SiteRow,
    event: string,
    message: string,
    level?: Level,
    meta: Record<string, unknown> = {},
): Promise<void> {
    try {
        await ServerLogService.record({
            userId: Number(req.user?.userId),
            teamId: Number(site.team_id),
            serverId: site.server_id,
            event,
            ...(level ? { level } : {}),
            message,
            meta: { site_id: site.id, ...meta },
        });
    } catch (err) {
        console.error(`Couldn't write the SSL log entry for site ${site.id}:`, err);
    }
}

/** Why this site can't take an SSL change right now, or null when it can. */
function refusal(site: SiteRow): { code: string; error: string } | null {
    if (site.status !== "ready") {
        return {
            code: "site_not_ready",
            error: `HTTPS can be changed once the site has finished creating. It is "${site.status}" right now.`,
        };
    }

    const age = Date.now() - new Date(site.updated_at).getTime();
    if (site.ssl_status === "working" && age < STALE_MS) {
        const minutes = Math.max(1, Math.round(age / 60_000));
        return {
            code: "ssl_busy",
            error: `An HTTPS change started ${minutes} minute${minutes === 1 ? "" : "s"} ago and is still running. Wait for it to finish.`,
        };
    }

    return null;
}

const pem = (value: unknown) => String(value ?? "").replace(/\r\n/g, "\n").trim();
const day = (value: string) => new Date(value).toISOString().slice(0, 10);

/** The names a certificate is issued for, for error messages. */
function namesOf(cert: X509Certificate): string {
    const alt = String(cert.subjectAltName ?? "")
        .split(",")
        .map((p) => p.trim().replace(/^DNS:/, ""))
        .filter(Boolean);
    return (alt.length > 0 ? alt.join(", ") : cert.subject.replace(/\n/g, ", ")).slice(0, 200);
}

/**
 * Checks a pasted certificate and key against each other and the site.
 * Returns field errors (empty when fine), the expiry date, and any aliases
 * the certificate doesn't cover (not an error, but worth logging).
 */
function checkPair(certificate: string, privateKey: string, domain: string, aliases: string[]) {
    const errors: Record<string, string[]> = {};
    let expires = "";
    let uncovered: string[] = [];

    let cert: X509Certificate | null = null;
    try {
        cert = new X509Certificate(certificate);
    } catch {
        errors.certificate = ["That doesn't parse as a certificate. Paste the server certificate (and the chain, if you have it) in PEM format."];
    }

    let key: ReturnType<typeof createPrivateKey> | null = null;
    try {
        key = createPrivateKey(privateKey);
    } catch {
        errors.private_key = ["That private key couldn't be read. Check that it is complete, has no passphrase and is in PEM format."];
    }

    if (cert) {
        const now = Date.now();
        expires = cert.validTo;

        if (new Date(cert.validTo).getTime() < now) {
            errors.certificate = [`That certificate expired on ${day(cert.validTo)}. Install a current one.`];
        } else if (new Date(cert.validFrom).getTime() > now) {
            errors.certificate = [`That certificate isn't valid until ${day(cert.validFrom)}.`];
        } else if (!cert.checkHost(domain)) {
            errors.certificate = [`That certificate doesn't cover ${domain}. It is issued for: ${namesOf(cert)}.`];
        } else {
            uncovered = aliases.filter((a) => !cert!.checkHost(a));
        }
    }

    if (cert && key && !cert.checkPrivateKey(key)) {
        errors.private_key = ["That private key doesn't match the certificate. Use the key that was generated with the certificate request."];
    }

    return { errors, expires, uncovered };
}

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

        const blocked = refusal(site);
        if (blocked) {
            await note(req, site, "site.ssl_refused", `HTTPS change for ${site.domain} refused: ${blocked.error}`, "warning", {
                code: blocked.code,
            });
            res.status(409);
            return res.json(blocked);
        }

        const aliases = parseAliases(site.aliases);
        const domains = [site.domain, ...aliases];

        const body = (req.body ?? {}) as Record<string, unknown>;
        const mode = String(body.mode ?? "");
        let request: SslRequest;
        let summary: string;
        let meta: Record<string, unknown> = { mode, domains };

        if (mode === "letsencrypt") {
            const email = String(body.email ?? "").trim().toLowerCase();
            if (!EMAIL.test(email) || email.length > 254) {
                const message = "Enter a valid email address.";
                await note(req, site, "site.ssl_rejected", `Let's Encrypt for ${site.domain} was not started: the email address wasn't valid.`, "warning", {
                    mode,
                    fields: ["email"],
                });
                res.status(422);
                return res.json({ error: message, code: "invalid_input", errors: { email: [message] } });
            }

            request = { mode: "letsencrypt", email };
            summary = `Let's Encrypt was requested for ${domains.join(", ")}.`;
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

            let expires = "";
            let uncovered: string[] = [];

            // Only inspect what already looks like PEM; the checks above gave the format errors.
            if (Object.keys(errors).length === 0) {
                const checked = checkPair(certificate, privateKey, site.domain, aliases);
                Object.assign(errors, checked.errors);
                expires = checked.expires;
                uncovered = checked.uncovered;
            }

            if (Object.keys(errors).length > 0) {
                const fields = Object.keys(errors);
                const first = errors[fields[0]][0];
                await note(req, site, "site.ssl_rejected", `A custom certificate for ${site.domain} was rejected: ${first}`, "warning", {
                    mode,
                    fields,
                });
                res.status(422);
                return res.json({ error: first, code: "invalid_input", errors });
            }

            request = { mode: "custom", certificate: certificate + "\n", privateKey: privateKey + "\n" };
            summary = `A custom certificate was submitted for ${domains.join(", ")}${expires ? ` (expires ${day(expires)})` : ""}.`;
            meta = { ...meta, expires_at: expires || null };

            if (uncovered.length > 0) {
                await note(
                    req,
                    site,
                    "site.ssl_alias_uncovered",
                    `The certificate for ${site.domain} doesn't cover: ${uncovered.join(", ")}. Visitors to those names will see a browser warning.`,
                    "warning",
                    { mode, aliases: uncovered },
                );
            }
        } else {
            const message = "Choose Let's Encrypt or a custom certificate.";
            await note(req, site, "site.ssl_rejected", `An HTTPS request for ${site.domain} was not started: no valid method was chosen.`, "warning", {
                fields: ["mode"],
            });
            res.status(422);
            return res.json({ error: message, code: "invalid_input", errors: { mode: [message] } });
        }

        await Site.update(site.id, { ssl_status: "working", ssl_error: "", ssl_log: "" });
        SiteSsl.start(site.id, request);

        await note(req, site, "site.ssl_started", summary, undefined, meta);

        res.status(202);
        return res.json({ status: "working" });
    }

    async disable(req: TylixRequest, res: TylixResponse) {
        const site = await findOwned(req, res);
        if (!site) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;

        const blocked = refusal(site);
        if (blocked) {
            await note(req, site, "site.ssl_refused", `Turning HTTPS off for ${site.domain} was refused: ${blocked.error}`, "warning", {
                code: blocked.code,
            });
            res.status(409);
            return res.json(blocked);
        }

        if (String(site.ssl_mode || "none") === "none") {
            const message = "HTTPS isn't enabled for this site.";
            await note(req, site, "site.ssl_refused", `Turning HTTPS off for ${site.domain} was refused: it isn't enabled.`, "warning", {
                code: "ssl_not_enabled",
            });
            res.status(409);
            return res.json({ error: message, code: "ssl_not_enabled" });
        }

        await Site.update(site.id, { ssl_status: "working", ssl_error: "", ssl_log: "" });
        SiteSsl.start(site.id, { mode: "none" });

        await note(req, site, "site.ssl_started", `Turning HTTPS off for ${site.domain} (it was ${String(site.ssl_mode)}).`, undefined, {
            mode: "none",
            previous: String(site.ssl_mode),
        });

        res.status(202);
        return res.json({ status: "working" });
    }
}