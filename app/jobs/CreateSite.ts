/**
 * Job: CreateSite
 *
 * Sets up a site on a server over SSH: isolated user and folders, clone,
 * dependency install, then php-fpm pool (PHP sites) and an nginx vhost.
 * Run by `npx tylix queue:work` (no timeout, no retry, no crash recovery), so
 * this job is written to be re-runnable:
 *
 *   - progress is the site's `step` (user > clone > install > webserver);
 *     a re-run resumes at the saved step
 *   - every command is idempotent (useradd only if missing, clone only if
 *     there is no checkout, config files are overwritten, nginx -t before reload)
 *   - the source-control token is decrypted only here, never written to the
 *     log, and removed from the git remote after cloning
 *   - every failure is written to the site row (never including tokens)
 *
 * Layout on the server: /home/<isolated_user>/<domain>
 */

import { Site } from "../models/Site.js";
import { Server } from "../models/Server.js";
import { SourceProvider } from "../models/SourceProvider.js";
import { CryptoService } from "../services/CryptoService.js";
import { sshExec } from "../services/Ssh.js";

const STEPS = ["user", "clone", "install", "webserver"] as const;
type Step = (typeof STEPS)[number];

const MAX_LOG = 50_000;

interface SiteRow {
    id: number;
    user_id: number;
    server_id: number;
    type: string;
    domain: string;
    aliases: string;
    isolated_user: string;
    php_version: string;
    port: number;
    source_control_id: number;
    repository: string;
    branch: string;
    web_directory: string;
    install_deps: number | boolean;
    status: string;
    step: string;
    error: string;
    log: string;
    [key: string]: unknown;
}

interface Target {
    host: string;
    port: number;
    user: string;
    privateKey: string;
}

/** Single-quote a value for a POSIX shell. */
const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

async function load(id: number): Promise<SiteRow> {
    const row = (await Site.find(id)) as SiteRow | null;
    if (!row) throw new Error(`Site ${id} not found.`);
    return row;
}

async function save(id: number, patch: Record<string, unknown>): Promise<void> {
    await Site.update(id, patch);
}

function nginxConfig(site: SiteRow, aliases: string[], root: string): string {
    const names = [site.domain, ...aliases].join(" ");

    const head = `server {
    listen 80;
    listen [::]:80;
    server_name ${names};
    root ${root};
    index index.php index.html;

    location ~ /\\.(?!well-known).* { deny all; }
`;

    if (site.type === "php") {
        return `${head}
    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php${site.php_version}-fpm-${site.isolated_user}.sock;
    }
}
`;
    }

    if (site.type === "nodejs") {
        return `${head}
    location / {
        proxy_pass http://127.0.0.1:${Number(site.port)};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
    }

    return `${head}
    location / {
        try_files $uri $uri/ =404;
    }
}
`;
}

function fpmPool(site: SiteRow): string {
    return `[${site.isolated_user}]
user = ${site.isolated_user}
group = ${site.isolated_user}
listen = /run/php/php${site.php_version}-fpm-${site.isolated_user}.sock
listen.owner = www-data
listen.group = www-data
pm = ondemand
pm.max_children = 10
pm.process_idle_timeout = 10s
`;
}

export const CreateSite = {
    async handle(payload: { siteId: number | string; [key: string]: unknown }) {
        const id = Number(payload.siteId);

        let site = await load(id);
        if (site.status === "ready") return;

        let log = site.log || "";
        const secrets: string[] = [];

        const redact = (text: string) => secrets.reduce((t, s) => (s ? t.split(s).join("***") : t), text);

        const note = async (text: string) => {
            log = (log + redact(text) + "\n").slice(-MAX_LOG);
            await save(id, { log });
        };

        try {
            const server = (await Server.find(site.server_id)) as
                | { user_id: number; host: string; port: number; ssh_user: string; ssh_key: string }
                | null;

            if (!server || server.user_id !== site.user_id) {
                throw new Error("The server no longer exists.");
            }

            const target: Target = {
                host: server.host,
                port: Number(server.port),
                user: server.ssh_user,
                privateKey: CryptoService.decrypt(server.ssh_key),
            };

            const aliases = (JSON.parse(site.aliases || "[]") as string[]) ?? [];
            const user = site.isolated_user;
            const dir = `/home/${user}/${site.domain}`;
            const root = site.web_directory ? `${dir}/${site.web_directory}` : dir;
            const hasRepo = Number(site.source_control_id) !== 0 && !!site.repository;
            const installDeps = hasRepo && Boolean(site.install_deps) && site.type !== "static";

            /** Run a command on the server; throw with the (redacted) tail on failure. */
            const run = async (label: string, command: string, timeoutMs = 120_000) => {
                await note(`$ ${label}`);
                const result = await sshExec(target, command, timeoutMs);
                const output = redact(`${result.stdout ?? ""}${result.stderr ?? ""}`).trim();
                if (output) await note(output.split("\n").slice(-30).join("\n"));
                if (result.code !== 0) {
                    const tail = output.split("\n").slice(-5).join(" ").slice(0, 300);
                    throw new Error(`${label} failed. ${tail}`);
                }
                return result;
            };

            const asUser = (script: string) => `runuser -u ${q(user)} -- bash -lc ${q(script)}`;

            await save(id, { status: "creating", error: "" });

            const saved = STEPS.indexOf(site.step as Step);
            const start = saved === -1 ? 0 : saved;

            for (const step of STEPS.slice(start)) {
                await save(id, { step });

                // 1. Isolated user and folders.
                if (step === "user") {
                    await run(
                        "Create user and folders",
                        [
                            `id -u ${q(user)} >/dev/null 2>&1 || useradd -m -s /bin/bash ${q(user)}`,
                            `chmod 711 ${q(`/home/${user}`)}`,
                            `mkdir -p ${q(dir)}`,
                            `chown ${q(user)}:${q(user)} ${q(dir)}`,
                            `chmod 755 ${q(dir)}`,
                        ].join(" && "),
                    );
                }

                // 2. Clone (or leave a placeholder page when there is no repository).
                if (step === "clone") {
                    if (hasRepo) {
                        const provider = (await SourceProvider.find(site.source_control_id)) as
                            | { user_id: number; kind: string; token: string }
                            | null;

                        if (!provider || provider.user_id !== site.user_id) {
                            throw new Error("The source control connection no longer exists.");
                        }

                        const token = CryptoService.decrypt(provider.token);
                        secrets.push(token, encodeURIComponent(token));

                        const host = provider.kind === "gitlab" ? "gitlab.com" : "github.com";
                        const login = provider.kind === "gitlab" ? "oauth2" : "x-access-token";
                        const cleanUrl = `https://${host}/${site.repository}.git`;
                        const authUrl = `https://${login}:${encodeURIComponent(token)}@${host}/${site.repository}.git`;

                        await run("Check git", "command -v git >/dev/null || { echo 'git is not installed on this server.'; exit 1; }");

                        await run(
                            `Clone ${site.repository} (${site.branch})`,
                            asUser(
                                [
                                    `cd ${q(dir)}`,
                                    `if [ -d .git ] && git rev-parse HEAD >/dev/null 2>&1; then echo 'Already cloned.'; else`,
                                    `find . -mindepth 1 -delete`,
                                    `git clone --branch ${q(site.branch)} --single-branch ${q(authUrl)} .`,
                                    `fi`,
                                    `git remote set-url origin ${q(cleanUrl)}`,
                                ].join("\n"),
                            ),
                            300_000,
                        );
                    } else {
                        await run(
                            "Create web directory",
                            [
                                `mkdir -p ${q(root)}`,
                                `[ -e ${q(`${root}/index.html`)} ] || [ -e ${q(`${root}/index.php`)} ] || echo ${q(b64(`<!doctype html><title>${site.domain}</title><h1>${site.domain}</h1><p>Site created with tylix-deployer.</p>\n`))} | base64 -d > ${q(`${root}/index.html`)}`,
                                `chown -R ${q(user)}:${q(user)} ${q(dir)}`,
                            ].join(" && "),
                        );
                    }
                }

                // 3. Dependencies.
                if (step === "install" && installDeps) {
                    if (site.type === "php") {
                        await run(
                            "Check composer",
                            "command -v composer >/dev/null || { echo 'composer is not installed on this server.'; exit 1; }",
                        );
                        await run(
                            "composer install --no-dev",
                            asUser(`cd ${q(dir)} && composer install --no-dev --no-interaction --prefer-dist`),
                            600_000,
                        );
                    }

                    if (site.type === "nodejs") {
                        await run(
                            "Check npm",
                            "command -v npm >/dev/null || { echo 'Node.js/npm is not installed on this server.'; exit 1; }",
                        );
                        await run("npm install", asUser(`cd ${q(dir)} && npm install`), 600_000);
                    }
                }

                // 4. php-fpm pool and nginx vhost.
                if (step === "webserver") {
                    await run(
                        "Check nginx",
                        "command -v nginx >/dev/null || { echo 'nginx is not installed on this server.'; exit 1; }",
                    );

                    if (site.type === "php") {
                        const v = site.php_version;
                        await run(
                            `Configure PHP ${v} pool`,
                            [
                                `test -d /etc/php/${v}/fpm || { echo 'PHP-FPM ${v} is not installed on this server.'; exit 1; }`,
                                `echo ${q(b64(fpmPool(site)))} | base64 -d > ${q(`/etc/php/${v}/fpm/pool.d/${user}.conf`)}`,
                                `php-fpm${v} -t`,
                                `systemctl reload php${v}-fpm`,
                            ].join(" && "),
                        );
                    }

                    const available = `/etc/nginx/sites-available/${site.domain}.conf`;
                    const enabled = `/etc/nginx/sites-enabled/${site.domain}.conf`;

                    await run(
                        "Configure nginx",
                        [
                            `echo ${q(b64(nginxConfig(site, aliases, root)))} | base64 -d > ${q(available)}`,
                            `ln -sf ${q(available)} ${q(enabled)}`,
                            `if nginx -t; then systemctl reload nginx; else rm -f ${q(enabled)}; exit 1; fi`,
                        ].join(" && "),
                    );
                }
            }

            await note("Site is ready.");
            await save(id, { step: "ready", status: "ready", error: "" });
        } catch (error) {
            const message = redact(error instanceof Error ? error.message : "Unknown error.");
            await note(`ERROR: ${message}`).catch(() => {});
            await save(id, { status: "failed", error: message.slice(0, 500) }).catch(() => {});
            throw error;
        }
    },
};