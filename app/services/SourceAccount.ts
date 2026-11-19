/**
 * The GitHub / GitLab account behind a source control token: who it is,
 * their picture and public profile, and what the token may do.
 *
 * Used when a token is checked (SourceProviderController saves the picture
 * and display name with the connection) and by the connection's detail page
 * (GET /api/source-providers/:id/profile). The token is only ever sent to
 * the provider; nothing here returns it.
 */

export interface SourceAccount {
    kind: string;
    username: string;
    name: string;
    avatar_url: string;
    profile_url: string;
    bio: string;
    company: string;
    location: string;
    website: string;
    email: string;
    account_type: string;
    plan: string;
    created_at: string;
    public_repos: number | null;
    private_repos: number | null;
    followers: number | null;
    following: number | null;
    // What the token is allowed to do, when the provider says.
    scopes: string[];
    token_name: string;
    token_expires_at: string;
    rate_limit: { remaining: number; limit: number; resets_at: string } | null;
}

export type AccountResult =
    | { ok: true; account: SourceAccount }
    | { ok: false; error: string; rejected: boolean };

export const providerName = (kind: string) => (kind === "github" ? "GitHub" : "GitLab");

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Only http(s) links are passed on to the page (they end up in href / src).
const link = (v: unknown) => {
    const s = str(v).trim();
    if (!s) return "";
    const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    try {
        const url = new URL(withScheme);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
    } catch {
        return "";
    }
};

function headersFor(kind: string, token: string): Record<string, string> {
    return kind === "github"
        ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "tylix-deploy" }
        : { "PRIVATE-TOKEN": token };
}

function empty(kind: string): SourceAccount {
    return {
        kind,
        username: "",
        name: "",
        avatar_url: "",
        profile_url: "",
        bio: "",
        company: "",
        location: "",
        website: "",
        email: "",
        account_type: "",
        plan: "",
        created_at: "",
        public_repos: null,
        private_repos: null,
        followers: null,
        following: null,
        scopes: [],
        token_name: "",
        token_expires_at: "",
        rate_limit: null,
    };
}

function scopeList(header: string | null): string[] {
    return (header ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function fromGitHub(body: Record<string, unknown>, response: Response): SourceAccount {
    const plan = (body.plan ?? {}) as Record<string, unknown>;
    const remaining = Number(response.headers.get("x-ratelimit-remaining"));
    const limit = Number(response.headers.get("x-ratelimit-limit"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));

    return {
        ...empty("github"),
        username: str(body.login),
        name: str(body.name),
        avatar_url: link(body.avatar_url),
        profile_url: link(body.html_url),
        bio: str(body.bio),
        company: str(body.company),
        location: str(body.location),
        website: link(body.blog),
        email: str(body.email),
        account_type: str(body.type),
        plan: str(plan.name),
        created_at: str(body.created_at),
        public_repos: num(body.public_repos),
        private_repos: num(body.total_private_repos),
        followers: num(body.followers),
        following: num(body.following),
        // Classic tokens list their scopes; fine-grained tokens don't.
        scopes: scopeList(response.headers.get("x-oauth-scopes")),
        token_expires_at: str(response.headers.get("github-authentication-token-expiration")),
        rate_limit:
            Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0
                ? {
                      remaining,
                      limit,
                      resets_at: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : "",
                  }
                : null,
    };
}

function fromGitLab(body: Record<string, unknown>): SourceAccount {
    return {
        ...empty("gitlab"),
        username: str(body.username),
        name: str(body.name),
        avatar_url: link(body.avatar_url),
        profile_url: link(body.web_url),
        bio: str(body.bio),
        company: str(body.organization) || str(body.job_title),
        location: str(body.location),
        website: link(body.website_url),
        email: str(body.public_email),
        account_type: body.bot ? "Bot" : "User",
        created_at: str(body.created_at),
        followers: num(body.followers),
        following: num(body.following),
    };
}

/** Looks up the account a token belongs to. `details` adds GitLab's token info (one more request). */
export async function fetchSourceAccount(kind: string, token: string, details = false): Promise<AccountResult> {
    const name = providerName(kind);
    const headers = headersFor(kind, token);

    let response: Response;
    try {
        response = await fetch(kind === "github" ? "https://api.github.com/user" : "https://gitlab.com/api/v4/user", {
            headers,
            signal: AbortSignal.timeout(10_000),
        });
    } catch {
        return { ok: false, rejected: false, error: `Couldn't reach ${name}. Try again in a moment.` };
    }

    if (response.status === 401 || response.status === 403) {
        return {
            ok: false,
            rejected: true,
            error: `${name} rejected that token. Check that it is correct and hasn't expired.`,
        };
    }
    if (!response.ok) {
        return { ok: false, rejected: false, error: `${name} answered with an error (${response.status}). Try again in a moment.` };
    }

    let body: Record<string, unknown>;
    try {
        body = (await response.json()) as Record<string, unknown>;
    } catch {
        return { ok: false, rejected: false, error: `${name} sent an answer we couldn't read. Try again in a moment.` };
    }

    if (kind === "github") return { ok: true, account: fromGitHub(body, response) };

    const account = fromGitLab(body);
    if (details) {
        try {
            const self = await fetch("https://gitlab.com/api/v4/personal_access_tokens/self", {
                headers,
                signal: AbortSignal.timeout(10_000),
            });
            if (self.ok) {
                const t = (await self.json()) as Record<string, unknown>;
                account.scopes = Array.isArray(t.scopes) ? t.scopes.map(String) : [];
                account.token_name = str(t.name);
                account.token_expires_at = str(t.expires_at);
            }
        } catch {
            // Token details are a nice-to-have: the profile is still shown.
        }
    }
    return { ok: true, account };
}
