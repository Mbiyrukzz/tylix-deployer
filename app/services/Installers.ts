/**
 * Template installers for a fresh Ubuntu machine (24.04 noble or 22.04 jammy).
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
 * The Ubuntu codename is read from /etc/os-release on the server, so repo
 * lines (MySQL, MongoDB) always match the installed release.
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

// Runs at the top of every step:
//   - waits for cloud-init / unattended-upgrades so they don't hold the dpkg lock
//   - repairs a half-configured dpkg left by an earlier failed run
//   - exposes $CODENAME (noble, jammy) for repo lines, and refuses non-Ubuntu
const HEADER = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=300 -y"
cloud-init status --wait >/dev/null 2>&1 || true
dpkg --configure -a || true
. /etc/os-release
CODENAME="$VERSION_CODENAME"
if [ "$ID" != "ubuntu" ]; then echo "Only Ubuntu images are supported (found $ID)."; exit 1; fi
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
echo "deb [signed-by=/usr/share/keyrings/mysql.gpg] http://repo.mysql.com/apt/ubuntu $CODENAME mysql-8.4-lts mysql-tools" > /etc/apt/sources.list.d/mysql.list
$APT update
$APT install mysql-server
systemctl enable --now mysql
[[ "$(mysqld --version)" == *"Ver 8.4"* ]]`,
);

const REDIS = once(
    "redis",
    "Installing Redis",
    `$APT install redis-server
systemctl enable --now redis-server`,
);

const MEMCACHED = once(
    "memcached",
    "Installing Memcached",
    `$APT install memcached
systemctl enable --now memcached`,
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
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-8.0.gpg ] https://repo.mongodb.org/apt/ubuntu $CODENAME/mongodb-org/8.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-8.0.list
$APT update
$APT install mongodb-org
systemctl enable --now mongod`,
);

const NODE = once(
    "node",
    "Installing Node.js 22",
    `curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
$APT install nodejs
[[ "$(node --version)" == v22* ]]`,
);

const TOOLS = once("tools", "Installing git and build tools", `$APT install git build-essential`);

// Python 3 with venv/pip and the headers most wheels need to compile (PostgreSQL
// driver, cryptography, Pillow). Used by FastAPI and Django sites: each site gets
// its own virtualenv, so nothing is installed system-wide with pip.
// MySQL client headers are left out on purpose: they can clash with the mysql.com
// packages. Use PyMySQL, or install default-libmysqlclient-dev by hand for mysqlclient.
const PYTHON = once(
    "python",
    "Installing Python 3",
    `$APT install python3 python3-venv python3-pip python3-dev build-essential pkg-config libpq-dev libffi-dev libssl-dev libjpeg-dev zlib1g-dev
python3 -c "import venv, ensurepip"`,
);

// OpenJDK 21 (the JDK, not just the JRE, so Maven/Gradle can compile) and Maven.
// Spring projects that ship mvnw or gradlew use their wrapper; unzip is needed by gradlew.
const JAVA = once(
    "java",
    "Installing Java 21 and Maven",
    `$APT install openjdk-21-jdk-headless maven unzip
[[ "$(javac -version 2>&1)" == *"21"* ]]`,
);

// Go from Ubuntu's own repository (1.22 on noble, 1.18 on jammy). Sites that need a
// newer toolchain can pull it with the "toolchain" line in go.mod (Go 1.21+).
const GO = once(
    "go",
    "Installing Go",
    `$APT install golang-go
go version`,
);

// System Ruby with the headers gems commonly compile against, plus Bundler.
// Rails sites that need a different Ruby should use a version manager instead.
const RUBY = once(
    "ruby",
    "Installing Ruby and Bundler",
    `$APT install ruby-full build-essential zlib1g-dev libyaml-dev libssl-dev libffi-dev libpq-dev
gem install bundler --no-document
ruby --version`,
);

// Rust through rustup, installed system-wide in /opt so every isolated user can build.
// The wrappers in /usr/local/bin set RUSTUP_HOME, so cargo works from any shell or
// systemd unit without a profile. Each site's registry cache goes in its own ~/.cargo.
// Ubuntu's packaged rustc is too old for many current crates, which is why rustup is used.
const RUST = once(
    "rust",
    "Installing Rust",
    `$APT install build-essential pkg-config libssl-dev
export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo
curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal
for t in cargo rustc rustup; do
  printf '#!/bin/sh\nexport RUSTUP_HOME=/opt/rustup\nexec /opt/cargo/bin/%s "$@"\n' "$t" > "/usr/local/bin/$t"
  chmod 755 "/usr/local/bin/$t"
done
chmod -R a+rX /opt/rustup /opt/cargo
cargo --version`,
);

// Bun installs to /usr/local so every user and every supervisor program finds it.
const BUN = once(
    "bun",
    "Installing Bun",
    `$APT install unzip
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
/usr/local/bin/bun --version`,
);

// .NET 8 SDK from Ubuntu's own repository (available on both noble and jammy).
const DOTNET = once(
    "dotnet",
    "Installing .NET 8 SDK",
    `$APT install dotnet-sdk-8.0
dotnet --version`,
);

// Docker Engine from Ubuntu's repository. Note: ports published with -p bypass UFW,
// so bind containers to 127.0.0.1 (-p 127.0.0.1:3000:3000) and let nginx proxy to them.
const DOCKER = once(
    "docker",
    "Installing Docker",
    `$APT install docker.io
systemctl enable --now docker
docker --version`,
);

// UFW goes last. The server's real SSH port is allowed before the firewall is
// switched on (servers added by hand may not use 22).
const UFW = once(
    "ufw",
    "Configuring firewall",
    `$APT install ufw
SSH_PORT=$(sshd -T 2>/dev/null | awk '/^port /{print $2}' | head -n 1) || true
[ -n "$SSH_PORT" ] || SSH_PORT=22
ufw default deny incoming
ufw default allow outgoing
ufw allow "$SSH_PORT"/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable`,
);

// Brings every installed package up to the latest version its repositories offer
// (Ubuntu, plus the NodeSource, MySQL, MongoDB and PHP repos added above).
// It never jumps to a new major release, and it never removes packages ("upgrade",
// not "dist-upgrade"). It always runs: there is no marker, so every click does real work.
//   - confdef/confold: keep the server's edited config files instead of prompting
//   - NEEDRESTART_MODE=a: restart the affected services automatically (a few seconds
//     of downtime each) instead of waiting on a prompt that nobody can answer
export const UPGRADE_ID = "upgrade";

const UPGRADE = always(
    UPGRADE_ID,
    "Updating installed packages",
    `export NEEDRESTART_MODE=a
$APT update
$APT -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade`,
);

function verify(services: string[], checkPostgres = false): InstallStep {
    // The "postgresql" unit is a wrapper that reports active even when the
    // cluster is down, so ask pg_lsclusters instead (works on any Ubuntu).
    const postgres = checkPostgres
        ? `\n[[ "$(pg_lsclusters -h)" == *online* ]] || { echo "postgresql is not running"; exit 1; }`
        : "";

    return always(
        "verify",
        "Checking services",
        `for s in ${services.join(" ")}; do
  systemctl is-active --quiet "$s" || { echo "$s is not running"; exit 1; }
done${postgres}
[[ "$(ufw status)" == *"Status: active"* ]] || { echo "ufw is not active"; exit 1; }`,
    );
}

export function installStepsFor(template: string): InstallStep[] {
    if (template === "standard") {
        return [BASE, NGINX, MYSQL, REDIS, SUPERVISOR, UFW, verify(["nginx", "mysql", "redis-server", "supervisor"])];
    }

    if (template === "tylix") {
        return [
            BASE, NGINX, MYSQL, REDIS, SUPERVISOR, POSTGRES, MONGO, NODE, TOOLS, PYTHON, JAVA, UFW,
            verify(["nginx", "mysql", "redis-server", "supervisor", "mongod"], true),
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

    // 400 chars keeps the real apt error; the job caps the whole message at 500.
    const tail = output ? output.slice(-400) : "No output. The step timed out or the connection dropped.";
    return { ok: false, tail };
}

// ---------------------------------------------------------------------------
// Package catalog: used by the per-server Packages page to install single
// components on an existing server. Dependencies resolve automatically.
// ---------------------------------------------------------------------------

function phpStep(v: string): InstallStep {
    const ext = ["fpm", "cli", "mysql", "pgsql", "sqlite3", "mbstring", "xml", "curl", "zip", "bcmath", "intl", "gd", "redis"]
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
const PNPM = once("pnpm", "Installing pnpm", `npm install -g pnpm`);
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
    { id: "php8.5", label: "PHP 8.5", group: "PHP", needs: ["base"], step: phpStep("8.5") },
    { id: "composer", label: "Composer", group: "PHP", needs: ["base"], step: COMPOSER },
    { id: "node", label: "Node.js 22", group: "Node", needs: ["base"], step: NODE },
    { id: "pm2", label: "PM2", group: "Node", needs: ["base", "node"], step: PM2 },
    { id: "pnpm", label: "pnpm", group: "Node", needs: ["base", "node"], step: PNPM },
    { id: "bun", label: "Bun", group: "Node", needs: ["base"], step: BUN },
    { id: "python", label: "Python 3 (venv, pip, build deps)", group: "Python", needs: ["base"], step: PYTHON },
    { id: "java", label: "Java 21 + Maven", group: "Java", needs: ["base"], step: JAVA },
    { id: "go", label: "Go", group: "Go", needs: ["base"], step: GO },
    { id: "ruby", label: "Ruby + Bundler", group: "Ruby", needs: ["base"], step: RUBY },
    { id: "rust", label: "Rust (rustup, cargo)", group: "Rust", needs: ["base"], step: RUST },
    { id: "dotnet", label: ".NET 8 SDK", group: ".NET", needs: ["base"], step: DOTNET },
    { id: "nginx", label: "nginx", group: "Web", needs: ["base"], step: NGINX },
    { id: "certbot", label: "Certbot (SSL)", group: "Web", needs: ["base", "nginx"], step: CERTBOT },
    { id: "mysql", label: "MySQL 8.4", group: "Databases", needs: ["base"], step: MYSQL },
    { id: "postgres", label: "PostgreSQL", group: "Databases", needs: ["base"], step: POSTGRES },
    { id: "mongo", label: "MongoDB 8", group: "Databases", needs: ["base"], step: MONGO },
    { id: "redis", label: "Redis", group: "Databases", needs: ["base"], step: REDIS },
    { id: "memcached", label: "Memcached", group: "Databases", needs: ["base"], step: MEMCACHED },
    { id: "supervisor", label: "Supervisor", group: "Tools", needs: ["base"], step: SUPERVISOR },
    { id: "tools", label: "git and build tools", group: "Tools", needs: ["base"], step: TOOLS },
    { id: "docker", label: "Docker", group: "Tools", needs: ["base"], step: DOCKER },
    { id: "ufw", label: "Firewall (UFW)", group: "Tools", needs: ["base"], step: UFW },
];

export function stepsForPackages(ids: string[]): InstallStep[] {
    const byId = new Map(PACKAGES.map((p) => [p.id, p]));
    const out: InstallStep[] = [];
    const seen = new Set<string>();
    const add = (id: string) => {
        if (id === UPGRADE_ID) {
            // Not a catalog package: the "update everything" action. Needs no prerequisites.
            if (!seen.has(UPGRADE_ID)) {
                seen.add(UPGRADE_ID);
                out.push(UPGRADE);
            }
            return;
        }
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
    "php8.5": "dpkg -s php8.5-fpm",
    composer: "command -v composer",
    node: "command -v node",
    pm2: "command -v pm2",
    pnpm: "command -v pnpm",
    bun: "command -v bun",
    python: "dpkg -s python3-venv && dpkg -s python3-dev",
    java: "command -v javac && command -v mvn",
    go: "command -v go",
    ruby: "command -v ruby && command -v bundle",
    rust: "command -v cargo && command -v rustc",
    dotnet: "command -v dotnet",
    nginx: "command -v nginx",
    certbot: "command -v certbot",
    mysql: "command -v mysqld",
    postgres: "dpkg -s postgresql",
    mongo: "command -v mongod",
    redis: "command -v redis-server",
    memcached: "command -v memcached",
    supervisor: "command -v supervisord",
    tools: "command -v git && command -v gcc",
    docker: "command -v docker",
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