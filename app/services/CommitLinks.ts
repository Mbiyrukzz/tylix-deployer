/**
 * Builds a link to a commit on GitHub or GitLab.
 *
 * `repository` may be "owner/repo", "https://host/owner/repo(.git)" or
 * "git@host:owner/repo.git". For the short form the host comes from the
 * source control kind ("gitlab" -> gitlab.com, anything else -> github.com).
 * Returns "" when it can't build a safe link.
 */

export function commitUrl(repository: string, kind: string, sha: string): string {
    const repo = String(repository ?? "").trim();
    const hash = String(sha ?? "").trim();
    if (!repo || !/^[0-9a-f]{7,64}$/i.test(hash)) return "";

    let host = "";
    let path = "";

    const ssh = repo.match(/^[\w.-]+@([^:/\s]+):(.+)$/);

    if (ssh) {
        host = ssh[1];
        path = ssh[2];
    } else if (/^https?:\/\//i.test(repo)) {
        try {
            const url = new URL(repo);
            host = url.host;
            path = url.pathname;
        } catch {
            return "";
        }
    } else {
        host = kind === "gitlab" ? "gitlab.com" : "github.com";
        path = repo;
    }

    path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");

    if (!host || !/^[\w.-]+(\/[\w.-]+)+$/.test(path)) return "";

    const gitlab = kind === "gitlab" || host.includes("gitlab");
    return `https://${host}/${path}${gitlab ? "/-/commit/" : "/commit/"}${hash}`;
}