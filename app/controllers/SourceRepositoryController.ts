/**
 * Repositories and branches for a source control connection.
 *
 *   GET /api/source-providers/:id/repositories
 *   GET /api/source-providers/:id/branches?repo=owner/name
 *
 * The saved token is decrypted here, used against GitHub/GitLab, and never
 * returned. Someone else's connection answers 404, not 403.
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { SourceProvider } from "../models/SourceProvider.js";
import { CryptoService } from "../services/CryptoService.js";

interface Row {
    id: number;
    user_id: number;
    kind: string;
    token: string;
    [key: string]: unknown;
}

interface Repo {
    full_name: string;
    name: string;
    private: boolean | null;
    default_branch: string;
    updated_at: string;
}

const PER_PAGE = 100;
const MAX_PAGES = 10;
const REPO = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){1,5}$/;

class ProviderError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message);
    }
}

function queryParam(req: TylixRequest, name: string): string {
    const bag = (req as unknown as { query?: Record<string, unknown> }).query;
    if (bag && typeof bag[name] === "string") return bag[name] as string;

    const url = String((req as unknown as { url?: string }).url ?? "");
    const at = url.indexOf("?");
    return at === -1 ? "" : (new URLSearchParams(url.slice(at + 1)).get(name) ?? "");
}

async function getPage(kind: string, token: string, url: string): Promise<unknown[]> {
    const name = kind === "github" ? "GitHub" : "GitLab";
    const headers: Record<string, string> =
        kind === "github"
            ? {
                  Authorization: `Bearer ${token}`,
                  Accept: "application/vnd.github+json",
                  "User-Agent": "tylix-deploy",
              }
            : { "PRIVATE-TOKEN": token };

    let response: Response;
    try {
        response = await fetch(url, { headers });
    } catch {
        throw new ProviderError(`Couldn't reach ${name}. Try again in a moment.`, 502);
    }

    // GitHub answers 409 for a repository that has no commits yet.
    if (response.status === 409) return [];

    if (!response.ok) {
        let detail = "";
        try {
            const body = (await response.json()) as { message?: string; error?: string };
            const text = body.message ?? body.error ?? "";
            if (text) detail = `: ${text}`;
        } catch {
            detail = "";
        }

        if (response.status === 401) {
            throw new ProviderError(`${name} rejected the saved token. Edit the connection and paste a new one${detail}`, 502);
        }
        if (response.status === 403) {
            throw new ProviderError(`${name} refused the request (403)${detail}`, 502);
        }
        if (response.status === 404) {
            throw new ProviderError(`${name} can't find that repository with this token (404)${detail}`, 404);
        }
        throw new ProviderError(`${name} answered with an error (${response.status})${detail}`, 502);
    }

    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

async function allPages(kind: string, token: string, makeUrl: (page: number) => string): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
        const items = await getPage(kind, token, makeUrl(page));
        all.push(...items);
        if (items.length < PER_PAGE) break;
    }
    return all;
}

async function listRepositories(kind: string, token: string): Promise<Repo[]> {
    if (kind === "github") {
        const items = (await allPages(
            kind,
            token,
            (p) =>
                `https://api.github.com/user/repos?per_page=${PER_PAGE}&page=${p}&sort=updated&affiliation=owner,collaborator,organization_member`,
        )) as Array<{ full_name: string; name: string; private: boolean; default_branch: string; pushed_at: string | null }>;

        return items.map((r) => ({
            full_name: r.full_name,
            name: r.name,
            private: r.private,
            default_branch: r.default_branch || "main",
            updated_at: r.pushed_at ?? "",
        }));
    }

    const items = (await allPages(
        kind,
        token,
        (p) =>
            `https://gitlab.com/api/v4/projects?membership=true&simple=true&per_page=${PER_PAGE}&page=${p}&order_by=last_activity_at`,
    )) as Array<{ path_with_namespace: string; path: string; default_branch?: string; last_activity_at?: string }>;

    return items.map((r) => ({
        full_name: r.path_with_namespace,
        name: r.path,
        private: null,
        default_branch: r.default_branch || "main",
        updated_at: r.last_activity_at ?? "",
    }));
}

async function listBranches(kind: string, token: string, repo: string): Promise<string[]> {
    const items =
        kind === "github"
            ? await allPages(
                  kind,
                  token,
                  (p) => `https://api.github.com/repos/${repo}/branches?per_page=${PER_PAGE}&page=${p}`,
              )
            : await allPages(
                  kind,
                  token,
                  (p) =>
                      `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo)}/repository/branches?per_page=${PER_PAGE}&page=${p}`,
              );

    return (items as Array<{ name: string }>).map((b) => b.name);
}

async function findOwned(req: TylixRequest, res: TylixResponse): Promise<Row | null> {
    const row = (await SourceProvider.find(req.params.id)) as Row | null;

    if (!row || row.user_id !== req.user?.userId) {
        res.status(404);
        res.json({ error: "Connection not found." });
        return null;
    }

    return row;
}

export class SourceRepositoryController {
    async repositories(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;

        try {
            const repos = await listRepositories(row.kind, CryptoService.decrypt(row.token));
            return res.json(repos);
        } catch (err) {
            const status = err instanceof ProviderError ? err.status : 502;
            res.status(status);
            return res.json({ error: err instanceof Error ? err.message : "Couldn't load repositories." });
        }
    }

    async branches(req: TylixRequest, res: TylixResponse) {
        const row = await findOwned(req, res);
        if (!row) return;

        const repo = queryParam(req, "repo").trim();
        if (!REPO.test(repo) || repo.split("/").some((p) => p === "." || p === "..")) {
            res.status(422);
            return res.json({ errors: { repo: ["Pick a repository."] } });
        }

        try {
            const branches = await listBranches(row.kind, CryptoService.decrypt(row.token), repo);
            return res.json(branches);
        } catch (err) {
            const status = err instanceof ProviderError ? err.status : 502;
            res.status(status);
            return res.json({ error: err instanceof Error ? err.message : "Couldn't load branches." });
        }
    }
}