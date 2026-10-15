/**
 * Feature: Provider (cloud provider connections)
 *
 * A provider row is one connected cloud account (a Linode personal access
 * token or a Hetzner Cloud project token). Same owner-scoped shape as
 * ServerController:
 *
 *   - api_token is encrypted with CryptoService before it is stored and is
 *     NEVER returned to the client (responses carry has_token instead)
 *   - the token is verified against the provider's API before it is saved
 *   - someone else's connection answers 404, not 403
 *
 * All routes sit behind requireAuth ("auth": true in feature.json).
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { Provider } from "../models/Provider.js";
import { Provision } from "../models/Provision.js";
import { validateProvider, normalizeProvider } from "../validators/ProviderValidator.js";
import { CryptoService } from "../services/CryptoService.js";
// HETZNER: replaces the direct LinodeClient/LinodeError imports.
import { adapterFor } from "../services/ProviderAdapter.js";

interface ProviderRow {
    id: number;
    user_id: number;
    kind: string;
    label: string;
    api_token: string;
    status: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

// HETZNER: per-provider wording for token errors.
const PROVIDER_NAMES: Record<string, string> = {
    linode: "Linode",
    hetzner: "Hetzner",
};

const TOKEN_HELP: Record<string, string> = {
    linode: "Create a personal access token with Linodes: Read/Write and try again.",
    hetzner: "Create an API token with Read & Write permission in your Cloud project and try again.",
};

/** Strips the encrypted token from anything that leaves the API. */
function toPublic(row: ProviderRow) {
    const { api_token, ...rest } = row;
    return { ...rest, has_token: Boolean(api_token) };
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
 * Returns null if the token works, otherwise the HTTP status and message to answer with.
 *
 * HETZNER: now provider-agnostic. verify() is a read-only call on both providers,
 * so a Hetzner token with Read-only permission passes here and only fails later,
 * when a server is created. Write access can't be checked without writing.
 */
async function checkToken(
    kind: string,
    token: string,
): Promise<{ status: number; message: string } | null> {
    const adapter = adapterFor(kind, token); // kind is validated before we get here

    try {
        await adapter.verify();
        return null;
    } catch (error) {
        const name = PROVIDER_NAMES[kind] ?? "the provider";

        if (adapter.isAuthError(error)) {
            return {
                status: 422,
                message: `${name} rejected this token. ${TOKEN_HELP[kind] ?? ""}`.trim(),
            };
        }
        return { status: 502, message: `Couldn't reach ${name} to verify the token. Try again in a moment.` };
    }
}

function tokenProblemBody(problem: { status: number; message: string }) {
    return problem.status === 422
        ? { errors: { api_token: [problem.message] } }
        : { error: problem.message };
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

        if (await isDuplicateLabel(req.user?.userId, input.label)) {
            res.status(409);
            return res.json({ error: "You already have a connection with that name." });
        }

        const problem = await checkToken(input.kind, input.api_token);
        if (problem) {
            res.status(problem.status);
            return res.json(tokenProblemBody(problem));
        }

        const provider = (await Provider.create({
            kind: input.kind,
            label: input.label,
            api_token: CryptoService.encrypt(input.api_token),
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

        const result = validateProvider(req.body, { isUpdate: true });
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

        if (input.api_token) {
            // The stored kind decides, never the request body: the type is fixed.
            const problem = await checkToken(provider.kind, input.api_token);
            if (problem) {
                res.status(problem.status);
                return res.json(tokenProblemBody(problem));
            }

            patch.api_token = CryptoService.encrypt(input.api_token);
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

        const provisions = (await Provision.all()) as {
            provider_id: number;
            instance_id: number;
            status: string;
        }[];
        const inUse = provisions.some(
            (p) => Number(p.provider_id) === provider.id && Number(p.instance_id) > 0 && p.status !== "deleted",
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
