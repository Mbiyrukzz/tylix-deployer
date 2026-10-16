/**
 * Feature: Provider (cloud provider connections)
 *
 * A provider row is one connected cloud account (a Linode, Hetzner,
 * DigitalOcean, Vultr or AWS credential). Same owner-scoped shape as ServerController:
 *
 *   - credentials are encrypted with CryptoService before they are stored and
 *     are NEVER returned to the client (responses carry has_token instead).
 *     Single-token providers use api_token; AWS keeps its access key pair as
 *     JSON in credentials.
 *   - the credentials are verified against the provider's API before they are saved
 *   - someone else's connection answers 404, not 403
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
// REF: instanceRefOf is new in this import. AWS: providerName replaces the local name table.
import { adapterFor, instanceRefOf, providerName } from "../services/ProviderAdapter.js";

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
    [key: string]: unknown;
}

const TOKEN_HELP: Record<string, string> = {
    linode: "Create a personal access token with Linodes: Read/Write and try again.",
    hetzner: "Create an API token with Read & Write permission in your Cloud project and try again.",
    digitalocean: "Create a personal access token with Read & Write scope and try again.",
    // VULTR: the access control list is the usual cause of a rejected key
    vultr: "Create an API key in Account → API, and allow this server's IP address (or all IPv4) in its access control list. Then try again.",
    // AWS: the IAM user needs the EC2 permissions listed in the form's help text
    aws: "Check the access key pair, and that its IAM user is allowed to use EC2 (describe, run and terminate instances). Then try again.",
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

/** Loads a connection and answers 404 itself if it is missing or not the caller's. */
async function findOwned(req: TylixRequest, res: TylixResponse): Promise<ProviderRow | null> {
    const provider = (await Provider.find(req.params.id)) as ProviderRow | null;

    if (!provider || provider.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Provider connection not found." });
        return null;
    }

    return provider;
}

async function isDuplicateLabel(
    userId: unknown,
    label: string,
    exceptId?: number,
): Promise<boolean> {
    const providers = (await Provider.all()) as ProviderRow[];
    return providers.some(
        (p) =>
            p.user_id === userId &&
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

/** A 422 lands on the credential field of the form, anything else is a general error. */
function tokenProblemBody(kind: string, problem: { status: number; message: string }) {
    if (problem.status !== 422) return { error: problem.message };

    const field = kind === "aws" ? "secret_access_key" : "api_token";
    return { errors: { [field]: [problem.message] } };
}

export class ProviderController {
    async index(req: TylixRequest, res: TylixResponse) {
        const providers = (await Provider.all()) as ProviderRow[];
        const own = providers
            .filter((p) => p.user_id === req.user?.userId)
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return res.json(own.map(toPublic));
    }

    async show(req: TylixRequest, res: TylixResponse) {
        const provider = await findOwned(req, res);
        if (!provider) return;

        return res.json(toPublic(provider));
    }

    async store(req: TylixRequest, res: TylixResponse) {
        const result = validateProvider(req.body);
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeProvider(req.body);
        const secret = credentialSecret(input.kind, input);

        if (await isDuplicateLabel(req.user?.userId, input.label)) {
            res.status(409);
            return res.json({ error: "You already have a connection with that name." });
        }

        const problem = await checkToken(input.kind, secret);
        if (problem) {
            res.status(problem.status);
            return res.json(tokenProblemBody(input.kind, problem));
        }

        const provider = (await Provider.create({
            kind: input.kind,
            label: input.label,
            ...sealed(input.kind, secret),
            status: "connected",
            user_id: req.user?.userId,
        })) as ProviderRow | null;

        if (!provider) {
            res.status(500);
            return res.json({ error: "Could not save the connection." });
        }

        res.status(201);
        return res.json(toPublic(provider));
    }

    async update(req: TylixRequest, res: TylixResponse) {
        const provider = await findOwned(req, res);
        if (!provider) return;

        // The stored kind decides, never the request body: the type is fixed.
        const result = validateProvider(req.body, { isUpdate: true, kind: provider.kind });
        if (!result.valid) {
            res.status(422);
            return res.json({ errors: result.errors });
        }

        const input = normalizeProvider(req.body);

        if (await isDuplicateLabel(req.user?.userId, input.label, provider.id)) {
            res.status(409);
            return res.json({ error: "You already have a connection with that name." });
        }

        const patch: Record<string, unknown> = { label: input.label };

        // Empty means "keep the stored credentials".
        const secret = credentialSecret(provider.kind, input);
        if (secret) {
            const problem = await checkToken(provider.kind, secret);
            if (problem) {
                res.status(problem.status);
                return res.json(tokenProblemBody(provider.kind, problem));
            }

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

        return res.json(toPublic(fresh));
    }

    async destroy(req: TylixRequest, res: TylixResponse) {
        const provider = await findOwned(req, res);
        if (!provider) return;

        // REF: widened row type, and "has a machine" now means "has a reference"
        // (Vultr ids are UUIDs and AWS refs are region/id, so Number(instance_id) > 0 would miss them).
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
        res.status(204);
        return res.end();
    }
}