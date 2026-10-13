/**
 * Template installers for a fresh Ubuntu 24.04 machine.
 *
 * Each step is a bash script run as root over SSH. A finished step leaves a
 * marker file on the server, so re-running a provision (Retry) skips what is
 * already installed instead of repeating it. The final "verify" step has no
 * marker: it always runs and fails the provision if a service isn't running.
 *
 * Steps run one at a time and each has its own timeout, so the provision row's
 * step changes often and the stuck-provision sweep never mistakes a healthy
 * install for a dead one.
 *
 * remote-monitor needs nothing on the server: stats are read over SSH.
 */

import { sshExec, type SshTarget } from "./Ssh.js";

export interface InstallStep {
    id: string;
    label: string;
    script: string;
}

export interface InstallResult {
    ok: boolean;
    tail: string;
}

const STEP_TIMEOUT_MS = 10 * 60 * 1000;

const HEADER = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=300 -y"
`;

/** A step that runs once and leaves a marker. */
function once(id: string, label: string, body: string): InstallStep {
    const script = `${HEADER}DONE=/var/lib/tylix-deploy/${id}.done
if [ -f "$DONE" ]; then exit 0; fi
${body}
mkdir -p /var/lib/tylix-deploy
touch "$DONE"
`;
    return { id, label, script };
}

/** A step that always runs. */
function always(id: string, label: string, body: string): InstallStep {
    return { id, label, script: `${HEADER}${body}\n` };
}

const BASE = once(
    "base",
    "Installing base packages",
    `$APT update
$APT install ca-certificates curl gnupg`,
);

const NGINX = once(
    "nginx",
    "Installing nginx",
    `$APT install nginx
systemctl enable --now nginx`,
);

const MYSQL = once(
    "mysql",
    "Installing MySQL 8.4",
    `install -d -m 0755 /usr/share/keyrings
curl -fsSL https://repo.mysql.com/RPM-GPG-KEY-mysql-2025 | gpg --dearmor --yes -o /usr/share/keyrings/mysql.gpg
echo "deb [signed-by=/usr/share/keyrings/mysql.gpg] http://repo.mysql.com/apt/ubuntu noble mysql-8.4-lts mysql-tools" > /etc/apt/sources.list.d/mysql.list
$APT update
$APT install mysql-server
systemctl enable --now mysql
mysqld --version | grep -q "8\\.4"`,
);

const REDIS = once(
    "redis",
    "Installing Redis",
    `$APT install redis-server
systemctl enable --now redis-server`,
);

const SUPERVISOR = once(
    "supervisor",
    "Installing Supervisor",
    `$APT install supervisor
systemctl enable --now supervisor`,
);

const POSTGRES = once(
    "postgres",
    "Installing PostgreSQL",
    `$APT install postgresql
systemctl enable --now postgresql`,
);

const MONGO = once(
    "mongo",
    "Installing MongoDB",
    `install -d -m 0755 /usr/share/keyrings
curl -fsSL https://www.mongodb.org/static/pgp/server-8.0.asc | gpg --dearmor --yes -o /usr/share/keyrings/mongodb-server-8.0.gpg
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu noble/mongodb-org/8.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-8.0.list
$APT update
$APT install mongodb-org
systemctl enable --now mongod`,
);

const NODE = once(
    "node",
    "Installing Node.js 22",
    `curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
$APT install nodejs
node --version | grep -q "^v22"`,
);

const TOOLS = once("tools", "Installing git and build tools", `$APT install git build-essential`);

// UFW goes last. SSH (22) is allowed before the firewall is switched on.
const UFW = once(
    "ufw",
    "Configuring firewall",
    `$APT install ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable`,
);

function verify(services: string[]): InstallStep {
    return always(
        "verify",
        "Checking services",
        `for s in ${services.join(" ")}; do
  systemctl is-active --quiet "$s" || { echo "$s is not running"; exit 1; }
done
ufw status | grep -q "Status: active" || { echo "ufw is not active"; exit 1; }`,
    );
}

export function installStepsFor(template: string): InstallStep[] {
    if (template === "standard") {
        return [BASE, NGINX, MYSQL, REDIS, SUPERVISOR, UFW, verify(["nginx", "mysql", "redis-server", "supervisor"])];
    }

    if (template === "tylix") {
        return [
            BASE, NGINX, MYSQL, REDIS, SUPERVISOR, POSTGRES, MONGO, NODE, TOOLS, UFW,
            verify(["nginx", "mysql", "redis-server", "supervisor", "postgresql", "mongod"]),
        ];
    }

    if (template === "bare") {
        return [];
    }

    throw new Error(`Unknown template "${template}".`);
}

/**
 * Runs one step. The script travels base64-encoded so no quoting can break it,
 * and stdin is closed so no command can swallow the script.
 */
export async function runInstallStep(target: SshTarget, step: InstallStep): Promise<InstallResult> {
    const encoded = Buffer.from(step.script, "utf8").toString("base64");
    const command = `bash -c "$(echo ${encoded} | base64 -d)" </dev/null 2>&1`;

    const result = await sshExec(target, command, STEP_TIMEOUT_MS);
    const output = (result.stdout || result.stderr || "").trim();

    if (result.code === 0) return { ok: true, tail: "" };

    const tail = output ? output.slice(-300) : "No output. The step timed out or the connection dropped.";
    return { ok: false, tail };
}

// ---------------------------------------------------------------------------
// Package catalog: used by the per-server Packages page to install single
// components on an existing server. Dependencies resolve automatically.
// ---------------------------------------------------------------------------

function phpStep(v: string): InstallStep {
    const ext = ["fpm", "cli", "mysql", "pgsql", "mbstring", "xml", "curl", "zip", "bcmath", "intl", "gd", "redis"]
        .map((e) => `php${v}-${e}`)
        .join(" ");
    return once(
        `php${v}`,
        `Installing PHP ${v}`,
        `$APT install software-properties-common
add-apt-repository -y ppa:ondrej/php
$APT update
$APT install ${ext}
systemctl enable --now php${v}-fpm`,
    );
}

const COMPOSER = once("composer", "Installing Composer", `$APT install composer unzip`);
const PM2 = once("pm2", "Installing PM2", `npm install -g pm2`);
const CERTBOT = once("certbot", "Installing Certbot", `$APT install certbot python3-certbot-nginx`);

export interface PackageDef {
    id: string;
    label: string;
    group: string;
    needs: string[];
    step: InstallStep;
}

export const PACKAGES: PackageDef[] = [
    { id: "php8.1", label: "PHP 8.1", group: "PHP", needs: ["base"], step: phpStep("8.1") },
    { id: "php8.2", label: "PHP 8.2", group: "PHP", needs: ["base"], step: phpStep("8.2") },
    { id: "php8.3", label: "PHP 8.3", group: "PHP", needs: ["base"], step: phpStep("8.3") },
    { id: "php8.4", label: "PHP 8.4", group: "PHP", needs: ["base"], step: phpStep("8.4") },
    { id: "composer", label: "Composer", group: "PHP", needs: ["base"], step: COMPOSER },
    { id: "node", label: "Node.js 22", group: "Node", needs: ["base"], step: NODE },
    { id: "pm2", label: "PM2", group: "Node", needs: ["base", "node"], step: PM2 },
    { id: "nginx", label: "nginx", group: "Web", needs: ["base"], step: NGINX },
    { id: "certbot", label: "Certbot (SSL)", group: "Web", needs: ["base", "nginx"], step: CERTBOT },
    { id: "mysql", label: "MySQL 8.4", group: "Databases", needs: ["base"], step: MYSQL },
    { id: "postgres", label: "PostgreSQL", group: "Databases", needs: ["base"], step: POSTGRES },
    { id: "mongo", label: "MongoDB 8", group: "Databases", needs: ["base"], step: MONGO },
    { id: "redis", label: "Redis", group: "Databases", needs: ["base"], step: REDIS },
    { id: "supervisor", label: "Supervisor", group: "Tools", needs: ["base"], step: SUPERVISOR },
    { id: "tools", label: "git and build tools", group: "Tools", needs: ["base"], step: TOOLS },
    { id: "ufw", label: "Firewall (UFW)", group: "Tools", needs: ["base"], step: UFW },
];

export function stepsForPackages(ids: string[]): InstallStep[] {
    const byId = new Map(PACKAGES.map((p) => [p.id, p]));
    const out: InstallStep[] = [];
    const seen = new Set<string>();
    const add = (id: string) => {
        if (id === "base") {
            // Always-needed prerequisite; not a user-selectable package.
            if (!seen.has("base")) {
                seen.add("base");
                out.push(BASE);
            }
            return;
        }
        const p = byId.get(id);
        if (!p) throw new Error(`Unknown package "${id}".`);
        if (seen.has(id)) return;
        seen.add(id);
        p.needs.forEach(add);
        out.push(p.step);
    };
    ids.forEach(add);
    return out;
}

// ---------------------------------------------------------------------------
// Detection: asks the server what is installed (works for servers added by
// hand too, not only ones this app provisioned).
// ---------------------------------------------------------------------------

const CHECKS: Record<string, string> = {
    "php8.1": "dpkg -s php8.1-fpm",
    "php8.2": "dpkg -s php8.2-fpm",
    "php8.3": "dpkg -s php8.3-fpm",
    "php8.4": "dpkg -s php8.4-fpm",
    composer: "command -v composer",
    node: "command -v node",
    pm2: "command -v pm2",
    nginx: "command -v nginx",
    certbot: "command -v certbot",
    mysql: "command -v mysqld",
    postgres: "dpkg -s postgresql",
    mongo: "command -v mongod",
    redis: "command -v redis-server",
    supervisor: "command -v supervisord",
    tools: "command -v git && command -v gcc",
    ufw: "command -v ufw",
};

export async function detectInstalled(target: SshTarget): Promise<string[]> {
    const script = Object.entries(CHECKS)
        .map(([id, test]) => `if ${test} >/dev/null 2>&1; then echo "${id}"; fi`)
        .join("\n");
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const result = await sshExec(target, `bash -c "$(echo ${encoded} | base64 -d)" </dev/null 2>/dev/null`, 30_000);

    if (result.code !== 0 && !result.stdout) {
        throw new Error("Couldn't reach the server to check what is installed.");
    }

    return result.stdout.split("\n").map((l) => l.trim()).filter((l) => l in CHECKS);
}
