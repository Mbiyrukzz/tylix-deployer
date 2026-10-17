/**
 * Feature: Registrar (domain registrar / DNS host connections)
 *
 * Same owner-scoped shape as ProviderController:
 *   - credentials are encrypted with CryptoService and NEVER returned
 *     (responses carry has_token instead)
 *   - credentials are verified against the registrar's API before they are saved
 *   - someone else's connection answers 404, not 403
 *   - responses carry `features`, so the UI knows which sections to show
 *
 * All routes sit behind requireAuth ("auth": true in feature.json).
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

interface RegistrarRow {
    id: number;
    user_id: number;
    kind: string;
    label: string;
    api_token: string;
    credentials: string;
    status: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

const HELP: Record<string, string> = {
    porkbun: "Check the API key and secret key, and that API access is switched on for the domains you want to manage (Domain Management, Details, API Access). Then try again.",
    cloudflare: "Create an API token with Zone: Read and DNS: Edit (add Email Routing Rules: Edit for forwarding) and try again.",
    godaddy: "Use production API keys from developer.godaddy.com. GoDaddy limits Domains API access to accounts with enough domains. Then try again.",
    namecheap: "Check the API user and key, switch on API access (Profile, Tools, Namecheap API Access) and whitelist this server's IP there. The IP you enter here must be that same address.",
    dynadot: "Check the API key (Tools, API in Dynadot). If you restricted the key by IP, allow this server's IP.",
    namecom: "Use your Name.com username and a production API token from name.com/account/settings/api. The test-environment token won't work.",
    spaceship: "Create an API key in Spaceship's API Manager with domains and DNS permissions, then paste the key and the secret.",
    route53: "Check the access key ID and secret. The IAM user also needs Route 53 and Route 53 Domains permissions; the keys alone are checked here, the permissions on first use.",
};

const AUTH_FIELD: Record<string, string> = {
    porkbun: "secret_key",
    godaddy: "api_secret",
    namecheap: "api_key",
    dynadot: "api_key",
    namecom: "api_token",
    spaceship: "api_secret",
    route53: "secret_key",
};

function toPublic(row: RegistrarRow) {
    const { api_token, credentials, ...rest } = row;
    return { ...rest, has_token: Boolean(api_token || credentials), features: featuresOf(row.kind) };
}

function sealed(kind: string, secret: string): { api_token: string; credentials: string } {
    const encrypted = CryptoService.encrypt(secret);
    return MULTI_FIELD_KINDS.includes(kind)
        ? { api_token: "", credentials: encrypted }
        : { api_token: encrypted, credentials: "" };
}

async function findOwned(req: TylixRequest, res: TylixResponse): Promise<RegistrarRow | null> {
    const row = (await Registrar.find(req.params.id)) as RegistrarRow | null;

    if (!row || row.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Registrar connection not found." });
        return null;
    }
    return row;
}

async function isDuplicateLabel(userId: unknown, label: string, exceptId?: number): Promise<boolean> {
    const rows = (await Registrar.all()) as RegistrarRow[];
    return rows.some(
        (r) => r.user_id === userId && r.label.toLowerCase() === label.toLowerCase() && r.id !== exceptId,
    );
}

/** Null if the credentials work, otherwise the status and message to answer with. */
async function checkSecret(kind: string, secret: string): Promise<{ status: number; message: string } | null> {
    const name = registrarName(kind);

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
        if (adapter.isAuthError(error)) {
            return { status: 422, message: `${name} rejected these credentials. ${HELP[kind] ?? ""}`.trim() };
        }
        console.error(`[registrar] ${kind} verify failed:`, error instanceof Error ? error.message : error);
        return { status: 502, message: `Couldn't reach ${name} to verify the credentials. Try again in a moment.` };
    }
}

function problemBody(kind: string, problem: { status: number; message: string }) {
    if (problem.status !== 422) return { error: problem.message };
    return { errors: { [AUTH_FIELD[kind] ?? "api_token"]: [problem.message] } };
}

export class RegistrarController {
    async index(req: TylixRequest, res: TylixResponse) {
        const rows = (await Registrar.all()) as RegistrarRow[];
        const own = rows
            .filter((r) => r.user_id === req.user?.userId)
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return res.json(own.map(toPublic));
    }

    async show(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;
        return res.json(toPublic(row));
    }

    async store(req: TylixRequest, res: TylixResponse) {
        const result = validateRegistrar(req.body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeRegistrar(req.body);
        const secret = credentialSecret(input.kind, input);

        if (await isDuplicateLabel(req.user?.userId, input.label)) {
            res.status(409);
            return res.json({ error: "You already have a connection with that name." });
        }

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
        })) as RegistrarRow | null;

        if (!row) {
            res.status(500);
            return res.json({ error: "Could not save the connection." });
        }

        res.status(201);
        return res.json(toPublic(row));
    }

    async update(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;

        // The stored kind decides, never the request body.
        const result = validateRegistrar(req.body, { isUpdate: true, kind: row.kind });
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeRegistrar(req.body);

        if (await isDuplicateLabel(req.user?.userId, input.label, row.id)) {
            res.status(409);
            return res.json({ error: "You already have a connection with that name." });
        }

        const patch: Record<string, unknown> = { label: input.label };

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

    async destroy(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;

        // Nothing depends on a registrar connection: removing it only forgets the key.
        await Registrar.delete(row.id);
        res.status(204);
        return res.end();
    }
}