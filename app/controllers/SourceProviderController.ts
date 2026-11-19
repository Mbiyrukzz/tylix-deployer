/**
 * Feature: SourceProvider (hand-written, replaces the generated CRUD controller)
 *
 * A connection to GitHub or GitLab, made with a personal access token.
 *   - the token is verified against the provider before it is saved
 *   - the token is stored encrypted and is NEVER returned
 *   - a connection on another team answers 404, not 403
 *   - any team member can list them; adding, changing and removing need the admin role
 *
 * Two-factor: replacing the token needs a valid code when the caller has
 * two-factor on (requireStepUp: wrong codes are counted and lock the user
 * out). It runs last, after GitHub / GitLab accepted the new token, so a
 * rejected token never spends a code. A rename without a new token never
 * asks for a code.
 *
 * Hardening (same as ProviderController):
 *   - checking a token is rate limited per user (it calls GitHub / GitLab)
 *   - tokens the provider REJECTED are counted per user; too many in a row
 *     lock the user out for a while, so this can't be used to test stolen tokens
 *   - adding, replacing the token on and removing a connection are logged
 *
 * Do not re-run `make:feature SourceProvider`: it would overwrite this file.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { SourceProvider } from "../models/SourceProvider.js";
import { CryptoService } from "../services/CryptoService.js";
import { createGuard, createFailureGate, userKey, audit, requireStepUp } from "../services/RouteGuard.js";
import { requireTeam, requireRole, teamIdOfRow } from "../services/TeamScope.js";
import { requireActive } from "../services/EntitlementService.js";
import { fetchSourceAccount, providerName } from "../services/SourceAccount.js";
import type { SourceAccount } from "../services/SourceAccount.js";
import { Site } from "../models/Site.js";

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
    avatar_url?: string | null;
    display_name?: string | null;
    created_at: string;
    updated_at: string;
    [key: string]: unknown;
}

const FIFTEEN_MINUTES = 15 * 60_000;

const verifyGuard = createGuard({ max: 20, windowMs: FIFTEEN_MINUTES, scope: "user", what: "token checks" });
const rejectGate = createFailureGate({ max: 5, windowMs: FIFTEEN_MINUTES, what: "rejected tokens" });

function toPublic(row: Row) {
    const { token, ...rest } = row;
    return rest;
}

type Verified =
    | { ok: true; username: string; avatar_url: string; display_name: string }
    | { ok: false; error: string; rejected: boolean };

async function verify(kind: string, token: string): Promise<Verified> {
    const checked = await fetchSourceAccount(kind, token);
    if (!checked.ok) return checked;
    const { username, avatar_url, name } = checked.account;
    return { ok: true, username, avatar_url, display_name: name };
}

/**
 * Throttle, lockout and the real check in one place. Answers the HTTP error
 * itself and returns null; otherwise returns the verified account.
 */
async function verifyOrRefuse(
    req: TylixRequest,
    res: TylixResponse,
    kind: string,
    token: string,
): Promise<Extract<Verified, { ok: true }> | null> {
    const key = userKey(req);

    if (!verifyGuard(req, res)) return null;
    if (!rejectGate.check(key, res)) return null;

    const checked = await verify(kind, token);

    if (!checked.ok) {
        if (checked.rejected) rejectGate.fail(key);
        res.status(422);
        res.json({ errors: { token: [checked.error] } });
        return null;
    }

    rejectGate.clear(key);
    return checked;
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

// The detail page calls the provider with the team's token, so lookups are
// limited per user and an answer is reused for a few minutes. A new token
// (updated_at changes) is never served an old answer.
const profileGuard = createGuard({ max: 30, windowMs: 60_000, scope: "user", what: "profile lookups" });
const PROFILE_TTL_MS = 5 * 60_000;
const profileCache = new Map<number, { key: string; at: number; account: SourceAccount }>();

interface SiteRow {
    id: number;
    team_id: number | null;
    server_id: number;
    domain: string;
    repository: string;
    branch: string;
    status: string;
    deploy_status: string;
    deployed_at: string | null;
}

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

    /**
     * The account behind the connection (picture, profile, token scopes),
     * fresh from GitHub / GitLab, plus the team's sites that deploy from it.
     * Any member. Also keeps the saved picture and name up to date.
     */
    async profile(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;

        const teamId = await teamIdOfRow(row);
        const siteRows = (await Site.query().where("source_control_id", row.id).get()) as unknown as SiteRow[];
        const sites = siteRows
            .filter((s) => s.team_id === null || s.team_id === teamId)
            .map((s) => ({
                id: s.id,
                server_id: s.server_id,
                domain: s.domain,
                repository: s.repository,
                branch: s.branch,
                status: s.status,
                deploy_status: s.deploy_status,
                deployed_at: s.deployed_at,
            }));

        const cacheKey = `${row.updated_at}`;
        const cached = profileCache.get(row.id);
        if (cached && cached.key === cacheKey && Date.now() - cached.at < PROFILE_TTL_MS) {
            return res.json({ connection: toPublic(row), account: cached.account, account_error: "", sites });
        }

        if (!profileGuard(req, res)) return;

        const checked = await fetchSourceAccount(row.kind, CryptoService.decrypt(row.token), true);
        if (!checked.ok) {
            const error = checked.rejected
                ? `${providerName(row.kind)} no longer accepts the saved token. An admin can edit the connection and paste a new one.`
                : checked.error;
            return res.json({ connection: toPublic(row), account: null, account_error: error, sites });
        }

        const account = checked.account;
        let current = row;
        if (account.avatar_url !== (row.avatar_url ?? "") || account.name !== (row.display_name ?? "")) {
            await SourceProvider.update(row.id, { avatar_url: account.avatar_url, display_name: account.name });
            current = ((await SourceProvider.find(row.id)) as Row | null) ?? row;
        }
        profileCache.set(row.id, { key: `${current.updated_at}`, at: Date.now(), account });

        return res.json({ connection: toPublic(current), account, account_error: "", sites });
    }

    async store(req: TylixRequest, res: TylixResponse) {
        const teamId = requireTeam(req, res);
        if (!teamId) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, teamId))) return;

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

        const checked = await verifyOrRefuse(req, res, kind, token);
        if (!checked) return;

        const row = (await SourceProvider.create({
            user_id: req.user?.userId,
            team_id: teamId,
            kind,
            label,
            username: checked.username,
            avatar_url: checked.avatar_url,
            display_name: checked.display_name,
            token: CryptoService.encrypt(token),
            status: "connected",
        })) as Row | null;

        if (!row) {
            res.status(500);
            return res.json({ error: "Couldn't save the connection." });
        }

        await audit({
            userId: Number(req.user?.userId),
            teamId,
            serverId: null,
            event: "source_provider.connected",
            level: "success",
            message: `${providerName(kind)} connection "${label}" was added.`,
            meta: { source_provider_id: row.id, kind },
        });

        res.status(201);
        return res.json(toPublic(row));
    }

    /**
     * Admin only. Replacing the token needs a second-factor code (body.code)
     * when the caller has one on. A rename never does.
     */
    async update(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;

        const body = (req.body ?? {}) as Record<string, unknown>;
        const label = str(body.label);
        const token = str(body.token);

        if (label.length < 1 || label.length > 60) {
            res.status(422);
            return res.json({ errors: { label: ["Give it a name of up to 60 characters."] } });
        }

        const teamId = await teamIdOfRow(row);

        // Stamp older rows with their team the first time they are saved.
        const patch: Record<string, unknown> = { label, team_id: teamId };

        // A blank token keeps the current one.
        const replaced = Boolean(token);

        if (replaced) {
            const checked = await verifyOrRefuse(req, res, row.kind, token);
            if (!checked) return;

            // Last gate before the write: second factor, if the caller has one on.
            // Runs after the provider accepted the token, so a rejected paste
            // never spends a code.
            if (!(await requireStepUp(req, res, "replace this connection's token"))) return;

            patch.token = CryptoService.encrypt(token);
            patch.username = checked.username;
            patch.avatar_url = checked.avatar_url;
            patch.display_name = checked.display_name;
            patch.status = "connected";
        }

        await SourceProvider.update(row.id, patch);
        const fresh = (await SourceProvider.find(row.id)) as Row | null;

        if (!fresh) {
            res.status(500);
            return res.json({ error: "Could not reload the connection after saving." });
        }

        await audit({
            userId: Number(req.user?.userId),
            teamId,
            serverId: null,
            event: replaced ? "source_provider.token_replaced" : "source_provider.updated",
            level: replaced ? "warning" : undefined,
            message: replaced
                ? `The token of ${providerName(row.kind)} connection "${fresh.label}" was replaced.`
                : `${providerName(row.kind)} connection "${fresh.label}" was updated.`,
            meta: { source_provider_id: row.id, kind: row.kind, token_replaced: replaced },
        });

        return res.json(toPublic(fresh));
    }

    async destroy(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;
        if (!requireRole(req, res, "admin")) return;
        if (!(await requireActive(res, Number(req.user?.teamId)))) return;

        await SourceProvider.delete(row.id);
        profileCache.delete(row.id);

        await audit({
            userId: Number(req.user?.userId),
            teamId: await teamIdOfRow(row),
            serverId: null,
            event: "source_provider.deleted",
            level: "warning",
            message: `${providerName(row.kind)} connection "${row.label}" was removed.`,
            meta: { source_provider_id: row.id, kind: row.kind },
        });

        res.status(204);
        return res.end();
    }
}