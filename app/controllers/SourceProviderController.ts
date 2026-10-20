/**
 * Feature: SourceProvider (hand-written, replaces the generated CRUD controller)
 *
 * A connection to GitHub or GitLab, made with a personal access token.
 *   - the token is verified against the provider before it is saved
 *   - the token is stored encrypted and is NEVER returned
 *   - a connection on another team answers 404, not 403
 *   - any team member can list them; adding, changing and removing need the admin role
 *
 * Do not re-run `make:feature SourceProvider`: it would overwrite this file.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { SourceProvider } from "../models/SourceProvider.js";
import { CryptoService } from "../services/CryptoService.js";
import { requireTeam, requireRole, teamIdOfRow } from "../services/TeamScope.js";

const KINDS = ["github", "gitlab"];

interface Row {
    id: number;
    user_id: number;
    team_id: number | null;
    kind: string;
    label: string;
    username: string;
    token: string;
    status: string;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

function toPublic(row: Row) {
    const { token, ...rest } = row;
    return rest;
}

type Verified = { ok: true; username: string } | { ok: false; error: string };

async function verify(kind: string, token: string): Promise<Verified> {
    const name = kind === "github" ? "GitHub" : "GitLab";

    try {
        const response =
            kind === "github"
                ? await fetch("https://api.github.com/user", {
                      headers: {
                          Authorization: `Bearer ${token}`,
                          Accept: "application/vnd.github+json",
                          "User-Agent": "tylix-deploy",
                      },
                  })
                : await fetch("https://gitlab.com/api/v4/user", {
                      headers: { "PRIVATE-TOKEN": token },
                  });

        if (response.status === 401 || response.status === 403) {
            return { ok: false, error: `${name} rejected that token. Check that it is correct and hasn't expired.` };
        }
        if (!response.ok) {
            return { ok: false, error: `${name} answered with an error (${response.status}). Try again in a moment.` };
        }

        const body = (await response.json()) as { login?: string; username?: string };
        const username = String(kind === "github" ? (body.login ?? "") : (body.username ?? ""));
        return { ok: true, username };
    } catch {
        return { ok: false, error: `Couldn't reach ${name} to check the token. Try again in a moment.` };
    }
}

async function findOwned(req: TylixRequest, res: TylixResponse): Promise<Row | null> {
    const teamId = requireTeam(req, res);
    if (!teamId) return null;

    const row = (await SourceProvider.find(req.params.id)) as Row | null;

    if (!row || (await teamIdOfRow(row)) !== teamId) {
        res.status(404);
        res.json({ error: "Connection not found." });
        return null;
    }

    return row;
}

const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export class SourceProviderController {
    async index(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;

        const rows = (await SourceProvider.all()) as Row[];
        const flags = await Promise.all(rows.map(async (r) => (await teamIdOfRow(r)) === teamId));
        const own = rows.filter((_, i) => flags[i]).sort((a, b) => b.id - a.id);
        return res.json(own.map(toPublic));
    }

    async show(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;
        return res.json(toPublic(row));
    }

    async store(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;
        if (!requireRole(req, res, "admin")) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const kind = str(body.kind).toLowerCase();
        const label = str(body.label);
        const token = str(body.token);

        const errors: Record<string, string[]> = {};
        if (!KINDS.includes(kind)) errors.kind = ["Choose GitHub or GitLab."];
        if (label.length < 1 || label.length > 60) errors.label = ["Give it a name of up to 60 characters."];
        if (!token) errors.token = ["Paste an access token."];

        if (Object.keys(errors).length > 0) {
            res.status(422);
            return res.json({ errors });
        }

        const checked = await verify(kind, token);
        if (!checked.ok) {
            res.status(422);
            return res.json({ errors: { token: [checked.error] } });
        }

        const row = (await SourceProvider.create({
            user_id: req.user?.userId,
            team_id: teamId,
            kind,
            label,
            username: checked.username,
            token: CryptoService.encrypt(token),
            status: "connected",
        })) as Row | null;

        if (!row) {
            res.status(500);
            return res.json({ error: "Couldn't save the connection." });
        }

        res.status(201);
        return res.json(toPublic(row));
    }

    async update(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;
        if (!requireRole(req, res, "admin")) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const label = str(body.label);
        const token = str(body.token);

        if (label.length < 1 || label.length > 60) {
            res.status(422);
            return res.json({ errors: { label: ["Give it a name of up to 60 characters."] } });
        }

        // Stamp older rows with their team the first time they are saved.
        const patch: Record<string, unknown> = { label, team_id: await teamIdOfRow(row) };

        // A blank token keeps the current one.
        if (token) {
            const checked = await verify(row.kind, token);
            if (!checked.ok) {
                res.status(422);
                return res.json({ errors: { token: [checked.error] } });
            }
            patch.token = CryptoService.encrypt(token);
            patch.username = checked.username;
            patch.status = "connected";
        }

        await SourceProvider.update(row.id, patch);
        const fresh = (await SourceProvider.find(row.id)) as Row;
        return res.json(toPublic(fresh));
    }

    async destroy(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;
        if (!requireRole(req, res, "admin")) return;

        await SourceProvider.delete(row.id);
        res.status(204);
        return res.end();
    }
}
