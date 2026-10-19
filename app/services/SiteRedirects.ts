/**
 * Per-site redirects, written to nginx over SSH.
 *
 * The rules live in /etc/nginx/tylix-plugins/<domain>/redirects.conf, the same
 * folder the plugins use. Each rule is a "# tylix-redirect {json}" comment
 * followed by its nginx block, so the file itself is the source of truth:
 * list() parses it back, and there is no database table.
 *
 * Every change rewrites the whole file, runs `nginx -t`, and puts the previous
 * file back if nginx rejects it (RedirectRejected). Everything that reaches the
 * config is validated against strict patterns first.
 */

import { createHash } from "node:crypto";
import { Server } from "../models/Server.js";
import { sshExec } from "./Ssh.js";
import { shellScript, serverTarget } from "./Shell.js";

export interface RedirectSite {
    id: number;
    server_id: number;
    domain: string;
    isolated_user: string;
    [key: string]: unknown;
}

export interface RedirectRule {
    id: string;
    match: "exact" | "prefix";
    from: string;
    to: string;
    code: number;
}

export const MAX_REDIRECTS = 100;
export const REDIRECT_CODES = [301, 302, 307, 308];

const MARK = "# tylix-redirect ";
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 60_000;

/** The request was wrong (bad input, duplicate, not found, busy). */
export class RedirectError extends Error {
    status: number;

    constructor(message: string, status = 422) {
        super(message);
        this.status = status;
    }
}

/** nginx -t refused the new redirects; the previous ones were restored. */
export class RedirectRejected extends Error {}

const FROM = /^\/[A-Za-z0-9._~\/@+,-]*$/;
const TO_PATH = /^\/[A-Za-z0-9._~\/@%+=,-]*$/;
const TO_URL = /^https?:\/\/([A-Za-z0-9.-]+)(?::\d{1,5})?(\/[A-Za-z0-9._~\/@%+=,-]*)?$/;

const idFor = (match: string, from: string) =>
    createHash("sha1").update(`${match}\n${from}`).digest("hex").slice(0, 12);

/** Validates one redirect and returns it in its clean form. */
export function checkRedirect(input: unknown, domain: string): { rule: RedirectRule } | { error: string } {
    const b = (input ?? {}) as Record<string, unknown>;

    const match = String(b.match ?? "exact");
    if (match !== "exact" && match !== "prefix") {
        return { error: "Choose how the old address should match." };
    }

    const code = Number(b.code ?? 301);
    if (!REDIRECT_CODES.includes(code)) {
        return { error: "Choose a redirect type: 301, 302, 307 or 308." };
    }

    let from = String(b.from ?? "").trim();
    const to = String(b.to ?? "").trim();

    if (from !== "" && !from.startsWith("/")) from = "/" + from;

    if (
        from.length < 1 ||
        from.length > 200 ||
        !FROM.test(from) ||
        from.includes("//") ||
        from.split("/").some((p) => p === "." || p === "..")
    ) {
        return { error: "The old address must be a path like /old-page, using only letters, digits and . _ ~ - / @ + ," };
    }

    if (match === "prefix") {
        from = from.replace(/\/+$/, "");
        if (from === "") {
            return { error: "A path-prefix redirect can't be the root. Use a folder like /blog." };
        }
    }

    let valid = false;
    let targetPath: string | null = null;

    if (to.length > 0 && to.length <= 500) {
        if (to.startsWith("/")) {
            valid = !to.startsWith("//") && TO_PATH.test(to);
            targetPath = to;
        } else {
            const m = TO_URL.exec(to);
            if (m) {
                valid = true;
                if (m[1].toLowerCase() === domain.toLowerCase()) targetPath = m[2] ?? "/";
            }
        }
    }

    if (!valid) {
        return { error: "Send it to a path like /new-page or a full URL like https://example.com/page (no ? or # in it)." };
    }

    if (targetPath !== null) {
        const loops = match === "exact" ? targetPath === from : targetPath === from || targetPath.startsWith(from + "/");
        if (loops) return { error: "That redirect would send visitors back to itself." };
    }

    return { rule: { id: idFor(match, from), match, from, to, code } };
}

function parse(text: string, domain: string): RedirectRule[] {
    const rules: RedirectRule[] = [];

    for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t.startsWith(MARK)) continue;

        try {
            const checked = checkRedirect(JSON.parse(t.slice(MARK.length)), domain);
            if ("rule" in checked) rules.push(checked.rule);
        } catch {
            // A line we can't read is skipped; the next save rewrites the file cleanly.
        }
    }

    return rules;
}

function render(rules: RedirectRule[]): string {
    const out: string[] = [
        "# Managed by Tylix (Site > Redirects). Changes made here by hand are overwritten.",
        "",
    ];

    for (const r of rules) {
        out.push(MARK + JSON.stringify({ match: r.match, from: r.from, to: r.to, code: r.code }));

        if (r.match === "exact") {
            out.push(`location = ${r.from} {`);
            out.push(`    return ${r.code} ${r.to}$is_args$args;`);
            out.push("}");
        } else {
            const re = r.from.replace(/[.+]/g, "\\$&");
            const base = r.to.replace(/\/+$/, "");
            out.push(`location ~ ^${re}(?:/(.*))?$ {`);
            out.push(`    return ${r.code} ${base}/$1$is_args$args;`);
            out.push("}");
        }

        out.push("");
    }

    return out.join("\n");
}

function lastLine(stderr: string, stdout: string): string {
    const clean = (text: string) =>
        text
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "" && !l.startsWith("Warning: Permanently added"));

    const err = clean(stderr);
    const lines = err.length > 0 ? err : clean(stdout);
    return (lines[lines.length - 1] ?? "Command failed.").slice(0, 300);
}

async function targetFor(site: RedirectSite) {
    const server = await Server.find(site.server_id);
    if (!server) throw new Error("The server no longer exists.");
    return serverTarget(server as never);
}

async function readRules(site: RedirectSite): Promise<RedirectRule[]> {
    const target = await targetFor(site);

    const script = shellScript(
        { DOMAIN: site.domain, SITE_USER: site.isolated_user },
        `
SNIP="/etc/nginx/tylix-plugins/$DOMAIN/redirects.conf"
if [ -f "$SNIP" ]; then
  $SUDO cat "$SNIP"
fi`,
    );

    const result = await sshExec(target, script, READ_TIMEOUT_MS);
    if (result.code !== 0) throw new Error(lastLine(result.stderr, result.stdout));

    return parse(String(result.stdout ?? ""), site.domain);
}

async function writeRules(site: RedirectSite, rules: RedirectRule[]): Promise<void> {
    const target = await targetFor(site);

    const script = shellScript(
        {
            DOMAIN: site.domain,
            SITE_USER: site.isolated_user,
            REDIRECTS_B64: Buffer.from(render(rules), "utf8").toString("base64"),
        },
        `
CONF="/etc/nginx/sites-available/$DOMAIN.conf"
[ -f "$CONF" ] || { echo "The nginx config $CONF was not found on the server." >&2; exit 1; }

SNIP_DIR="/etc/nginx/tylix-plugins/$DOMAIN"
SNIP="$SNIP_DIR/redirects.conf"
BACKUP_DIR="/etc/nginx/tylix-backups"
BACKUP="$BACKUP_DIR/$DOMAIN.redirects.bak"
$SUDO mkdir -p "$SNIP_DIR" "$BACKUP_DIR"

if ! grep -qF "tylix-plugins/$DOMAIN/" "$CONF"; then
  $SUDO sed -i "/server_name /a include /etc/nginx/tylix-plugins/$DOMAIN/*.conf;" "$CONF"
fi

TMP="$(mktemp)"
printf '%s' "$REDIRECTS_B64" | base64 -d > "$TMP"

HAD=0
if [ -f "$SNIP" ]; then
  HAD=1
  $SUDO cp -p "$SNIP" "$BACKUP"
fi

$SUDO cp "$TMP" "$SNIP"
$SUDO chmod 644 "$SNIP"
rm -f "$TMP"

if ! OUT="$($SUDO nginx -t 2>&1)"; then
  if [ "$HAD" = "1" ]; then
    $SUDO cp -p "$BACKUP" "$SNIP"
  else
    $SUDO rm -f "$SNIP"
  fi
  echo "$OUT" >&2
  exit 3
fi

$SUDO systemctl reload nginx
echo "nginx reloaded"`,
    );

    const result = await sshExec(target, script, WRITE_TIMEOUT_MS);

    if (result.code === 3) {
        const text = String(result.stderr ?? "")
            .split("\n")
            .filter((l) => !l.trim().startsWith("Warning: Permanently added"))
            .join("\n")
            .trim()
            .slice(-3000);
        throw new RedirectRejected(text);
    }
    if (result.code !== 0) throw new Error(lastLine(result.stderr, result.stdout));
}

const busy = new Set<number>();

async function locked<T>(siteId: number, fn: () => Promise<T>): Promise<T> {
    if (busy.has(siteId)) {
        throw new RedirectError("Another redirect change is still running on this site. Try again in a moment.", 409);
    }

    busy.add(siteId);
    try {
        return await fn();
    } finally {
        busy.delete(siteId);
    }
}

export const SiteRedirects = {
    list(site: RedirectSite): Promise<RedirectRule[]> {
        return readRules(site);
    },

    async add(site: RedirectSite, input: unknown): Promise<{ rules: RedirectRule[]; rule: RedirectRule }> {
        const checked = checkRedirect(input, site.domain);
        if ("error" in checked) throw new RedirectError(checked.error);
        const rule = checked.rule;

        return locked(site.id, async () => {
            const current = await readRules(site);

            if (current.length >= MAX_REDIRECTS) {
                throw new RedirectError(`A site can have at most ${MAX_REDIRECTS} redirects.`);
            }
            if (current.some((r) => r.id === rule.id)) {
                throw new RedirectError("That address already has a redirect. Remove it first to change it.", 409);
            }

            const rules = [...current, rule];
            await writeRules(site, rules);
            return { rules, rule };
        });
    },

    async remove(site: RedirectSite, id: string): Promise<{ rules: RedirectRule[]; rule: RedirectRule }> {
        return locked(site.id, async () => {
            const current = await readRules(site);
            const rule = current.find((r) => r.id === id);

            if (!rule) throw new RedirectError("That redirect no longer exists.", 404);

            const rules = current.filter((r) => r.id !== id);
            await writeRules(site, rules);
            return { rules, rule };
        });
    },
};