/**
 * Feature: Registrar (domain registrar / DNS host connections)
 *
 * Same team-scoped shape as ProviderController (rows carry team_id; older rows
 * that were never stamped are resolved by teamIdOfRow). Any team member can
 * list connections; adding, changing and removing need the admin role.
 *
 *
 *   - credentials are encrypted with CryptoService and NEVER returned
 *     (responses carry has_token instead)
 *   - credentials are verified against the registrar's API before they are saved
 *   - a connection on another team answers 404, not 403
 *   - responses carry `features`, so the UI knows which sections to show
 *
 * All routes sit behind requireAuth ("auth": true in feature.json).
 *
 * Save flow (store / update):
 *   validateRegistrar()   shape checks, answers 422 with { errors: { field: [msg] } }
 *   credentialSecret()    packs the credential fields into one JSON string
 *   checkSecret()         builds the adapter and calls verify() against the real API
 *   sealed()              encrypts it and picks the column (credentials or api_token)
 *   Registrar.create/update
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Registrar } from "../models/Registrar.js";
import {
    validateRegistrar,
    normalizeRegistrar,
    credentialSecret,
    MULTI_FIELD_KINDS,
} from "../validators/RegistrarValidator.js";
import { CryptoService } from "../services/CryptoService.js";
import { registrarFor, registrarName, featuresOf } from "../services/RegistrarAdapter.js";
import { requireTeam, requireRole, teamIdOfRow } from "../services/TeamScope.js";
import { requireActive } from "../services/EntitlementService.js";

interface RegistrarRow {
    id: number;
    user_id: number;
    team_id: number | null;
    kind: string;
    label: string;
    api_token: string;
    credentials: string;
    status: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

/**
 * Shown under the credential fields when the registrar rejects them (422).
 * One short, actionable message per registrar.
 */
const HELP: Record<string, string> = {
    porkbun: "Check the API key and secret key, and that API access is switched on for the domains you want to manage (Domain Management, Details, API Access). Then try again.",
    cloudflare: "Create an API token (My Profile → API Tokens, or Manage Account → Account API Tokens) with Zone: Read and DNS: Edit (add Email Routing Rules: Edit for forwarding), and paste your Account ID from the account's overview page. Then try again.",
    godaddy: "Use production API keys from developer.godaddy.com. GoDaddy limits Domains API access to accounts with enough domains. Then try again.",
    namecheap: "Check the API user and key, switch on API access (Profile, Tools, Namecheap API Access) and whitelist this server's IP there. The IP you enter here must be that same address.",
    dynadot: "Check the API key (Tools, API in Dynadot). If you restricted the key by IP, allow this server's IP.",
    namecom: "Use your Name.com username and a production API token from name.com/account/settings/api. The test-environment token won't work.",
    spaceship: "Create an API key in Spaceship's API Manager with domains and DNS permissions, then paste the key and the secret.",
    route53: "Check the access key ID and secret. The IAM user also needs Route 53 and Route 53 Domains permissions; the keys alone are checked here, the permissions on first use.",
};

/**
 * Which form field a "credentials rejected" message is shown under.
 * Cloudflare isn't listed: it falls back to "api_token", which is the right
 * field (the token is what gets rejected).
 */
const AUTH_FIELD: Record<string, string> = {
    porkbun: "secret_key",
    godaddy: "api_secret",
    namecheap: "api_key",
    dynadot: "api_key",
    namecom: "api_token",
    spaceship: "api_secret",
    route53: "secret_key",
};

/** Strips every secret from a row before it leaves the server. */
function toPublic(row: RegistrarRow) {
    const { api_token, credentials, ...rest } = row;
    return { ...rest, has_token: Boolean(api_token || credentials), features: featuresOf(row.kind) };
}

/**
 * Encrypts the secret and says which column it goes in.
 * Every kind in MULTI_FIELD_KINDS (now including Cloudflare) uses `credentials`;
 * the other column is cleared, so an old Cloudflare row that used api_token is
 * moved over the first time its credentials are replaced.
 */
function sealed(kind: string, secret: string): { api_token: string; credentials: string } {
    const encrypted = CryptoService.encrypt(secret);
    return MULTI_FIELD_KINDS.includes(kind)
        ? { api_token: "", credentials: encrypted }
        : { api_token: encrypted, credentials: "" };
}

/** Loads the row for :id, or answers 404 (also when it is on another team). */
async function findOwned(req: TylixRequest, res: TylixResponse): Promise<RegistrarRow | null> {
    const teamId = requireTeam(req, res);
    if (!teamId) return null;

    const row = (await Registrar.find(req.params.id)) as RegistrarRow | null;

    if (!row || (await teamIdOfRow(row)) !== teamId) {
        res.status(404);
        res.json({ error: "Registrar connection not found." });
        return null;
    }
    return row;
}

/** Labels are unique per team, case-insensitive. `exceptId` lets a rename keep its own name. */
async function isDuplicateLabel(teamId: number, label: string, exceptId?: number): Promise<boolean> {
    const rows = (await Registrar.all()) as RegistrarRow[];
    for (const r of rows) {
        if (r.id === exceptId || r.label.toLowerCase() !== label.toLowerCase()) continue;
        if ((await teamIdOfRow(r)) === teamId) return true;
    }
    return false;
}

/** Null if the credentials work, otherwise the status and message to answer with. */
async function checkSecret(kind: string, secret: string): Promise<{ status: number; message: string } | null> {
    const name = registrarName(kind);

    // Building the adapter parses the secret; incomplete credentials throw here.
    let adapter;
    try {
        adapter = registrarFor(kind, secret);
    } catch (error) {
        return { status: 422, message: error instanceof Error ? error.message : "Invalid credentials." };
    }

    try {
        await adapter.verify();
        return null;
    } catch (error) {
        // The registrar said no: the user can fix this, so 422 with the HELP text.
        if (adapter.isAuthError(error)) {
            return { status: 422, message: `${name} rejected these credentials. ${HELP[kind] ?? ""}`.trim() };
        }
        // Anything else (network, 5xx, rate limit) is not the user's fault: 502.
        console.error(`[registrar] ${kind} verify failed:`, error instanceof Error ? error.message : error);
        return { status: 502, message: `Couldn't reach ${name} to verify the credentials. Try again in a moment.` };
    }
}

/** 422 becomes a field error (shown under the input), anything else a plain banner message. */
function problemBody(kind: string, problem: { status: number; message: string }) {
    if (problem.status !== 422) return { error: problem.message };
    return { errors: { [AUTH_FIELD[kind] ?? "api_token"]: [problem.message] } };
}

export class RegistrarController {
    /** GET /api/registrars: the team's connections, newest first. */
    async index(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;

        const rows = (await Registrar.all()) as RegistrarRow[];
        const flags = await Promise.all(rows.map(async (r) => (await teamIdOfRow(r)) === teamId));
        const own = rows
            .filter((_, i) => flags[i])
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return res.json(own.map(toPublic));
    }

    /** GET /api/registrars/:id */
    async show(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;
        return res.json(toPublic(row));
    }

    /** POST /api/registrars: validate, verify with the registrar, then save. */
    async store(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, teamId))) return;

        const result = validateRegistrar(req.body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeRegistrar(req.body);
        const secret = credentialSecret(input.kind, input);

        if (await isDuplicateLabel(teamId, input.label)) {
            res.status(409);
            return res.json({ error: "Your team already has a connection with that name." });
        }

        // Nothing is saved unless the registrar accepts the credentials.
        const problem = await checkSecret(input.kind, secret);
        if (problem) {
            res.status(problem.status);
            return res.json(problemBody(input.kind, problem));
        }

        const row = (await Registrar.create({
            kind: input.kind,
            label: input.label,
            ...sealed(input.kind, secret),
            status: "connected",
            user_id: req.user?.userId,
            team_id: teamId,
        })) as RegistrarRow | null;

        if (!row) {
            res.status(500);
            return res.json({ error: "Could not save the connection." });
        }

        res.status(201);
        return res.json(toPublic(row));
    }

    /**
     * PUT /api/registrars/:id
     * Always allows a rename. Credentials are replaced only when the request
     * carries a full set (credentialSecret() returns "" otherwise).
     */
    async update(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;

        // The stored kind decides, never the request body.
        const result = validateRegistrar(req.body, { isUpdate: true, kind: row.kind });
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeRegistrar(req.body);

        if (await isDuplicateLabel(await teamIdOfRow(row), input.label, row.id)) {
            res.status(409);
            return res.json({ error: "Your team already has a connection with that name." });
        }

        // Stamp older rows with their team the first time they are saved.
        const patch: Record<string, unknown> = { label: input.label, team_id: await teamIdOfRow(row) };

        // Empty means "keep the stored credentials".
        const secret = credentialSecret(row.kind, input);
        if (secret) {
            const problem = await checkSecret(row.kind, secret);
            if (problem) {
                res.status(problem.status);
                return res.json(problemBody(row.kind, problem));
            }
            Object.assign(patch, sealed(row.kind, secret));
            patch.status = "connected";
        }

        await Registrar.update(row.id, patch);
        const fresh = (await Registrar.find(row.id)) as RegistrarRow | null;

        if (!fresh) {
            res.status(500);
            return res.json({ error: "Could not reload the connection after saving." });
        }
        return res.json(toPublic(fresh));
    }

    /** DELETE /api/registrars/:id */
    async destroy(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;

        // Nothing depends on a registrar connection: removing it only forgets the key.
        await Registrar.delete(row.id);
        res.status(204);
        return res.end();
    }
}