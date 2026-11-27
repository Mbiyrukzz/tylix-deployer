/**
 * Connects an existing site to a repository from one of the team's source
 * control connections (or disconnects it), so Flux can deploy it again. Used
 * for imported sites and for sites whose repository moved or was never set.
 *
 * connect() runs one SSH call as the site user, in /home/<user>/<domain>:
 *
 *   1. origin is set to https://<github|gitlab>.com/<owner/repo>.git (no
 *      token in the URL; deploys pass the token per command, like SiteDeployer)
 *   2. git fetch origin <branch> with the connection's token. This proves the
 *      token can read the repository and that the branch exists.
 *   3. the checkout follows <branch>:
 *        - already on it, and the commit is part of origin/<branch>: nothing to do
 *        - on another branch: git checkout (git refuses if local changes
 *          would be lost), as long as the current commit was pushed
 *        - no git checkout in the folder, or history that isn't part of
 *          origin/<branch> (another repository, unpushed commits): refused
 *          with needsReset, unless the caller passed reset
 *   4. reset: git checkout -f -B <branch> origin/<branch>. Tracked files take
 *      the branch's version (files only the old checkout tracked are
 *      removed); untracked files (.env, uploads, storage) stay.
 *
 * Any failure puts the previous origin back, so a mistyped repository never
 * leaves the site pulling from somewhere else.
 *
 * Nothing is saved on the site until the server side worked.
 */

import { SourceProvider } from "../models/SourceProvider.js";
import { Server } from "../models/Server.js";
import { CryptoService } from "./CryptoService.js";
import { sshExec } from "./Ssh.js";
import { shellScript, serverTarget } from "./Shell.js";
import { teamIdOfRow } from "./TeamScope.js";

export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const BRANCH = /^[A-Za-z0-9._\/-]{1,100}$/;
const USER = /^[a-z][a-z0-9_-]{0,31}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const TIMEOUT_MS = 3 * 60_000;
const MARK = "__TYLIX_SOURCE__";

export interface SourceSite {
    id: number;
    user_id: number;
    team_id: number | null;
    server_id: number;
    domain: string;
    isolated_user: string;
    [key: string]: unknown;
}

export interface ConnectResult {
    ok: boolean;
    /** The folder has no checkout, or history that isn't on origin/<branch>: needs reset to go on. */
    needsReset: "" | "no_git" | "diverged";
    error: string;
    commit: string;
    message: string;
    log: string;
}

export class SourceError extends Error {
    constructor(message: string, public status = 422) {
        super(message);
    }
}

const SCRIPT = `
cd "$SITE_ROOT" || { echo "The site folder $SITE_ROOT doesn't exist." >&2; exit 4; }
AUTH="$(printf '%s:%s' "$GIT_USER" "$GIT_TOKEN" | base64 -w0)"
git_auth() {
  as_user env GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader "GIT_CONFIG_VALUE_0=Authorization: Basic $AUTH" git "$@"
}

FRESH=0
if [ ! -d .git ]; then
  if [ "$RESET" != "1" ]; then
    echo "${MARK}no_git"
    exit 9
  fi
  as_user git init -q
  FRESH=1
  echo "Started a git checkout in $SITE_ROOT"
fi

# Until the end, a failure puts the old origin back: the site keeps deploying
# from where it did, since nothing is saved in Flux either.
OLD_URL="$(as_user git config --get remote.origin.url 2>/dev/null || true)"
DONE=0
restore() {
  if [ "$DONE" != "1" ] && [ "$FRESH" != "1" ]; then
    if [ -n "$OLD_URL" ]; then
      as_user git remote set-url origin "$OLD_URL" 2>/dev/null || true
    else
      as_user git remote remove origin 2>/dev/null || true
    fi
  fi
}
trap restore EXIT

if [ -n "$OLD_URL" ]; then
  as_user git remote set-url origin "$PUBLIC_URL"
else
  as_user git remote add origin "$PUBLIC_URL"
fi
echo "origin is $PUBLIC_URL"

if ! git_auth fetch --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"; then
  echo "Couldn't fetch $BRANCH from $PUBLIC_URL. Check that the connection can read this repository and that the branch exists." >&2
  exit 5
fi
echo "Fetched $BRANCH"

if [ "$RESET" = "1" ]; then
  as_user git checkout -q -f -B "$BRANCH" "origin/$BRANCH"
  as_user git branch -q --set-upstream-to="origin/$BRANCH" "$BRANCH"
  echo "The folder now matches origin/$BRANCH (files the repository doesn't track were kept)"
else
  CUR="$(as_user git symbolic-ref --short -q HEAD || true)"
  FF=0
  if as_user git merge-base --is-ancestor HEAD "origin/$BRANCH" 2>/dev/null; then FF=1; fi
  # Same branch: deploys pull --ff-only, so the folder must be behind origin.
  # Another branch: fine as long as what is checked out now was pushed somewhere.
  if [ "$FF" != "1" ]; then
    PUSHED="$(as_user git for-each-ref --contains HEAD refs/remotes/origin 2>/dev/null | head -n 1)"
    if [ "$CUR" = "$BRANCH" ] || [ -z "$CUR" ] || [ -z "$PUSHED" ]; then
      echo "${MARK}diverged"
      exit 10
    fi
  fi
  if [ "$CUR" != "$BRANCH" ]; then
    if as_user git show-ref --verify --quiet "refs/heads/$BRANCH"; then
      as_user git checkout -q "$BRANCH"
    else
      as_user git checkout -q -b "$BRANCH" --track "origin/$BRANCH"
    fi
    echo "Switched to $BRANCH"
  fi
  as_user git branch -q --set-upstream-to="origin/$BRANCH" "$BRANCH" || true
fi

DONE=1
echo "${MARK}commit $(as_user git rev-parse HEAD)"
echo "${MARK}message $(as_user git log -1 --format=%s | head -c 300 | base64 -w0)"
`;

export const SiteSource = {
    async connect(
        site: SourceSite,
        input: { sourceControlId: number; repository: string; branch: string; reset: boolean },
    ): Promise<ConnectResult> {
        const teamId = await teamIdOfRow(site);

        if (!REPO.test(input.repository)) throw new SourceError("Use the owner/repository format.");
        if (!BRANCH.test(input.branch) || input.branch.includes("..")) throw new SourceError("That branch name isn't valid.");
        if (!USER.test(String(site.isolated_user)) || !DOMAIN.test(String(site.domain))) {
            throw new SourceError("This site's stored user or domain looks invalid.");
        }

        const sc = (await SourceProvider.find(input.sourceControlId)) as
            | { id: number; kind: string; token: string; user_id: number; team_id?: number | null }
            | null;
        if (!sc || (await teamIdOfRow(sc)) !== teamId) throw new SourceError("Source control connection not found.", 404);
        if (sc.kind !== "github" && sc.kind !== "gitlab") throw new SourceError("Only GitHub and GitLab connections can deploy.");

        const server = (await Server.find(site.server_id)) as { user_id: number; team_id?: number | null } | null;
        if (!server || (await teamIdOfRow(server)) !== teamId) throw new SourceError("The server no longer exists.", 409);

        const host = sc.kind === "gitlab" ? "gitlab.com" : "github.com";
        const vars = {
            SITE_USER: site.isolated_user,
            SITE_ROOT: `/home/${site.isolated_user}/${site.domain}`,
            BRANCH: input.branch,
            PUBLIC_URL: `https://${host}/${input.repository}.git`,
            GIT_USER: sc.kind === "gitlab" ? "oauth2" : "x-access-token",
            GIT_TOKEN: CryptoService.decrypt(sc.token),
            RESET: input.reset ? "1" : "0",
        };

        const r = await sshExec(serverTarget(server as never), shellScript(vars, SCRIPT), TIMEOUT_MS);
        const out = `${r.stdout}\n${r.stderr}`.split(vars.GIT_TOKEN).join("***");
        const log = out
            .split("\n")
            .filter((l) => l.trim() && !l.startsWith(MARK))
            .join("\n")
            .trim();

        const result: ConnectResult = { ok: false, needsReset: "", error: "", commit: "", message: "", log };

        if (r.code === 255) {
            result.error = "Couldn't reach the server over SSH.";
            return result;
        }
        if (out.includes(`${MARK}no_git`)) {
            result.needsReset = "no_git";
            result.error = "The site folder has no git checkout yet.";
            return result;
        }
        if (out.includes(`${MARK}diverged`)) {
            result.needsReset = "diverged";
            result.error = `The folder's code isn't part of ${input.branch} in ${input.repository} (another repository, or commits that were never pushed), so deploys couldn't fast-forward.`;
            return result;
        }
        if (r.code !== 0) {
            const lines = String(r.stderr || r.stdout).split(vars.GIT_TOKEN).join("***").split("\n").filter((l) => l.trim());
            result.error = (lines[lines.length - 1] ?? "The command failed.").slice(0, 300);
            return result;
        }

        for (const line of out.split("\n")) {
            if (line.startsWith(`${MARK}commit `)) result.commit = line.slice(MARK.length + 7).trim();
            if (line.startsWith(`${MARK}message `)) {
                try {
                    result.message = Buffer.from(line.slice(MARK.length + 8).trim(), "base64").toString("utf8").trim();
                } catch {
                    result.message = "";
                }
            }
        }
        result.ok = true;
        return result;
    },
};
