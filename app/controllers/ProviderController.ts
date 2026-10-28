/**
 * Feature: Provider (cloud provider connections)
 *
 * A provider row is one connected cloud account (a Linode, Hetzner,
 * DigitalOcean, Vultr or AWS credential). Team-scoped, like ServerController:
 *
 *   - any team member can list and view connections
 *   - creating, updating and deleting need the admin role
 *   - adding a connection is checked against the team's plan
 *     (EntitlementService); editing and deleting are never limited
 *   - credentials are encrypted with CryptoService before they are stored and
 *     are NEVER returned to the client (responses carry has_token instead).
 *     Single-token providers use api_token; AWS keeps its access key pair as
 *     JSON in credentials.
 *   - the credentials are verified against the provider's API before they are saved
 *   - a connection on another team answers 404, not 403 (checked before the role)
 *
 * Two-factor: replacing the credentials of a connection needs a valid code
 * when the caller has two-factor on (requireStepUp: wrong codes are counted
 * and lock the user out). It runs last, after the provider has accepted the
 * new credentials, so a refused request never spends a code. A rename without
 * new credentials never asks for a code.
 *
 * Hardening:
 *   - checking credentials is rate limited per user (it calls the provider)
 *   - rejected credentials are counted per user; too many in a row lock the
 *     user out for a while, so this can't be used to test stolen tokens
 *   - adding, replacing credentials on and deleting a connection are written
 *     to the log (never the credentials themselves)
 *
 * All routes sit behind requireAuth ("auth": true in feature.json).
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Provider } from "../models/Provider.js";
import { Provision } from "../models/Provision.js";
import {
    validateProvider,
    normalizeProvider,
    credentialSecret,
    MULTI_FIELD_KINDS,
} from "../validators/ProviderValidator.js";
import { CryptoService } from "../services/CryptoService.js";
import { adapterFor, instanceRefOf, providerName } from "../services/ProviderAdapter.js";
import { createGuard, createFailureGate, userKey, audit, requireStepUp } from "../services/RouteGuard.js";
import { requireTeam, requireRole } from "../services/TeamScope.js";
import { requireWithin, requireActive } from "../services/EntitlementService.js";

interface ProviderRow {
    id: number;
    user_id: number;
    kind: string;
    label: string;
    api_token: string;
    credentials: string; // AWS: encrypted JSON
    status: string;
    created_at: string;
    updated_at: string;
    team_id: number | null;
    [key: string]: unknown;
}

const FIFTEEN_MINUTES = 15 * 60_000;

// Every credential check calls the provider's API.
const verifyGuard = createGuard({ max: 20, windowMs: FIFTEEN_MINUTES, scope: "user", what: "credential checks" });

// Only counts checks the provider REJECTED, not ones it couldn't answer.
const rejectGate = createFailureGate({ max: 5, windowMs: FIFTEEN_MINUTES, what: "rejected credentials" });

const TOKEN_HELP: Record<string, string> = {
    linode: "Create a personal access token with Linodes: Read/Write and try again.",
    hetzner: "Create an API token with Read & Write permission in your Cloud project and try again.",
    digitalocean: "Create a personal access token with Read & Write scope and try again.",
    vultr: "Create an API key in Account → API, and allow this server's IP address (or all IPv4) in its access control list. Then try again.",
    aws: "Check the access key pair, and that its IAM user is allowed to use EC2 (describe, run and terminate instances). Then try again.",
    upcloud: "Check the API username and password, that API access is enabled for that account, and that this server's IP address is allowed. Then try again.",
    contabo: "Check the client ID, client secret, API user and API password from Account → Security & Access → API in the Contabo panel. Then try again.",
};

/** Strips the encrypted secrets from anything that leaves the API. */
function toPublic(row: ProviderRow) {
    const { api_token, credentials, ...rest } = row;
    return { ...rest, has_token: Boolean(api_token || credentials) };
}

/** What goes in which column: AWS in credentials, everything else in api_token. */
function sealed(kind: string, secret: string): { api_token: string; credentials: string } {
    const encrypted = CryptoService.encrypt(secret);
    return MULTI_FIELD_KINDS.includes(kind)
        ? { api_token: "", credentials: encrypted }
        : { api_token: encrypted, credentials: "" };
}

/** Loads a connection and answers 404 itself if it is missing or not on the caller's team. */
async function findOwned(req: TylixRequest, res: TylixResponse): Promise<ProviderRow | null> {
    const teamId = requireTeam(req, res);
    if (!teamId) return null;

    const provider = (await Provider.find(req.params.id)) as ProviderRow | null;

    if (!provider || Number(provider.team_id) !== teamId) {
        res.status(404);
        res.json({ error: "Provider connection not found." });
        return null;
    }

    return provider;
}

async function isDuplicateLabel(
    teamId: number,
    label: string,
    exceptId?: number,
): Promise<boolean> {
    const providers = (await Provider.all()) as ProviderRow[];
    return providers.some(
        (p) =>
            Number(p.team_id) === teamId &&
            p.label.toLowerCase() === label.toLowerCase() &&
            p.id !== exceptId,
    );
}

/**
 * Returns null if the credentials work, otherwise the HTTP status and message to answer with.
 *
 * verify() is a read-only call on every provider, so a read-only token passes
 * here and only fails later, when a server is created. Write access can't be
 * checked without writing.
 */
async function checkToken(
    kind: string,
    secret: string,
): Promise<{ status: number; message: string } | null> {
    const adapter = adapterFor(kind, secret); // kind is validated before we get here

    try {
        await adapter.verify();
        return null;
    } catch (error) {
        const name = providerName(kind);

        if (adapter.isAuthError(error)) {
            return {
                status: 422,
                message: `${name} rejected these credentials. ${TOKEN_HELP[kind] ?? ""}`.trim(),
            };
        }
        return { status: 502, message: `Couldn't reach ${name} to verify the credentials. Try again in a moment.` };
    }
}

/** Which form field a rejected-credentials error (422) is shown under. */
const AUTH_FIELD: Record<string, string> = {
    aws: "secret_access_key",
    upcloud: "password",
    contabo: "api_password",
};

function tokenProblemBody(kind: string, problem: { status: number; message: string }) {
    if (problem.status !== 422) return { error: problem.message };

    const field = AUTH_FIELD[kind] ?? "api_token";
    return { errors: { [field]: [problem.message] } };
}

/**
 * Throttle, lockout and the real check in one place. Answers the HTTP error
 * itself; true means the credentials are good and the caller can save them.
 */
async function verifyOrRefuse(
    req: TylixRequest,
    res: TylixResponse,
    kind: string,
    secret: string,
): Promise<boolean> {
    const key = userKey(req);

    if (!verifyGuard(req, res)) return false;
    if (!rejectGate.check(key, res)) return false;

    const problem = await checkToken(kind, secret);

    if (problem) {
        if (problem.status === 422) rejectGate.fail(key);
        res.status(problem.status);
        res.json(tokenProblemBody(kind, problem));
        return false;
    }

    rejectGate.clear(key);
    return true;
}

export class ProviderController {
    /** Any team member. */
    async index(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;

        const providers = (await Provider.all()) as ProviderRow[];
        const own = providers
            .filter((p) => Number(p.team_id) === teamId)
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return res.json(own.map(toPublic));
    }

    /** Any team member. */
    async show(req: TylixRequest, res: TylixResponse) {
        const provider = await findOwned(req, res);
        if (!provider) return;

        return res.json(toPublic(provider));
    }

    /** Admin only. Limited by the team's plan. */
    async store(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, teamId))) return;

        const result = validateProvider(req.body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeProvider(req.body);
        const secret = credentialSecret(input.kind, input);

        if (await isDuplicateLabel(teamId, input.label)) {
            res.status(409);
            return res.json({ error: "Your team already has a connection with that name." });
        }

        // Before the credential check, so a team over its limit doesn't wait on the provider's API.
        if (!(await requireWithin(res, teamId, "providers"))) return;

        if (!(await verifyOrRefuse(req, res, input.kind, secret))) return;

        const provider = (await Provider.create({
            kind: input.kind,
            label: input.label,
            ...sealed(input.kind, secret),
            status: "connected",
            user_id: req.user?.userId,
            team_id: teamId,
        })) as ProviderRow | null;

        if (!provider) {
            res.status(500);
            return res.json({ error: "Could not save the connection." });
        }

        await audit({
            userId: Number(req.user?.userId),
            teamId,
            serverId: null,
            event: "provider.connected",
            level: "success",
            message: `${providerName(provider.kind)} connection "${provider.label}" was added.`,
            meta: { provider_id: provider.id, kind: provider.kind },
        });

        res.status(201);
        return res.json(toPublic(provider));
    }

    /**
     * Admin only. A connection on another team answers 404 before the role is checked.
     * Replacing the credentials needs a second-factor code (body.code) when the caller has one on.
     */
    async update(req: TylixRequest, res: TylixResponse) {
        const provider = await findOwned(req, res);
        if (!provider) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;

        // The stored kind decides, never the request body: the type is fixed.
        const result = validateProvider(req.body, { isUpdate: true, kind: provider.kind });
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeProvider(req.body);

        if (await isDuplicateLabel(Number(provider.team_id), input.label, provider.id)) {
            res.status(409);
            return res.json({ error: "Your team already has a connection with that name." });
        }

        const patch: Record<string, unknown> = { label: input.label };

        // Empty means "keep the stored credentials".
        const secret = credentialSecret(provider.kind, input);
        const replaced = Boolean(secret);

        if (replaced) {
            if (!(await verifyOrRefuse(req, res, provider.kind, secret))) return;

            // Last gate before the write: second factor, if the caller has one on.
            // Runs after the provider accepted the credentials, so a rejected
            // paste never spends a code.
            if (!(await requireStepUp(req, res, "replace this connection's credentials"))) return;

            Object.assign(patch, sealed(provider.kind, secret));
            patch.status = "connected";
        }

        // ASSUMPTION: Model exposes update(id, data), same as ServerController.
        await Provider.update(provider.id, patch);
        const fresh = (await Provider.find(provider.id)) as ProviderRow | null;

        if (!fresh) {
            res.status(500);
            return res.json({ error: "Could not reload the connection after saving." });
        }

        await audit({
            userId: Number(req.user?.userId),
            teamId: Number(provider.team_id),
            serverId: null,
            event: replaced ? "provider.credentials_replaced" : "provider.updated",
            level: replaced ? "warning" : undefined,
            message: replaced
                ? `The credentials of ${providerName(provider.kind)} connection "${fresh.label}" were replaced.`
                : `${providerName(provider.kind)} connection "${fresh.label}" was updated.`,
            meta: { provider_id: provider.id, kind: provider.kind, credentials_replaced: replaced },
        });

        return res.json(toPublic(fresh));
    }

    /** Admin only. A connection on another team answers 404 before the role is checked. */
    async destroy(req: TylixRequest, res: TylixResponse) {
        const provider = await findOwned(req, res);
        if (!provider) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;

        // "Has a machine" means "has a reference" (Vultr ids are UUIDs and AWS
        // refs are region/id, so Number(instance_id) > 0 would miss them).
        const provisions = (await Provision.all()) as {
            provider_id: number;
            instance_id: number;
            instance_ref?: string;
            status: string;
        }[];
        const inUse = provisions.some(
            (p) =>
                Number(p.provider_id) === provider.id &&
                instanceRefOf(p) !== "" &&
                p.status !== "deleted",
        );
        if (inUse) {
            res.status(409);
            return res.json({
                error: "Servers created through this connection still exist. Delete them first, or you would lose the token needed to manage them.",
            });
        }

        await Provider.delete(provider.id);

        await audit({
            userId: Number(req.user?.userId),
            teamId: Number(provider.team_id),
            serverId: null,
            event: "provider.deleted",
            level: "warning",
            message: `${providerName(provider.kind)} connection "${provider.label}" was removed.`,
            meta: { provider_id: provider.id, kind: provider.kind },
        });

        res.status(204);
        return res.end();
    }
}