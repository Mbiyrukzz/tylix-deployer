/**
 * Every value checked here ends up in shell commands, nginx config or a
 * systemd runner script, so the patterns are strict on purpose.
 */

import { getType, isPhp, needsPort, PHP_VERSIONS } from "../services/SiteTypes.js";

type Body = Record<string, unknown>;

export interface NormalizedSite {
    server_id: number;
    source_control_id: number;
    type: string;
    domain: string;
    aliases: string[];
    isolated_user: string;
    php_version: string;
    port: number; // 0 = pick a free one (the controller does that)
    repository: string;
    branch: string;
    web_directory: string;
    app_directory: string;
    backend_directory: string;
    build_command: string;
    start_command: string;
    install_deps: boolean;
}

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const USER = /^[a-z][a-z0-9_-]{0,31}$/;
// owner/repo for GitHub, group/subgroup/project for GitLab.
const REPO = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){1,5}$/;
const BRANCH = /^[A-Za-z0-9._\/-]{1,100}$/;
const DIR = /^[A-Za-z0-9._\/-]+$/;
const COMMAND = /^[^\r\n\0]{1,200}$/;
const RESERVED_USERS = ["root", "www-data", "nginx", "ubuntu", "admin", "tylix", "mysql", "postgres", "redis"];

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const cleanDir = (v: unknown) => text(v).replace(/^\/+|\/+$/g, "");
const badDir = (dir: string) =>
    dir !== "" && (!DIR.test(dir) || dir.split("/").some((p) => p === ".." || p === "."));

function deriveUser(b: Body, domain: string): string {
    let user = text(b.isolated_user).toLowerCase();
    if (!user && domain) {
        user = domain.split(".")[0].replace(/[^a-z0-9_-]/g, "").replace(/^[^a-z]+/, "");
    }
    return user;
}

function cleanAliases(b: Body): string[] {
    const raw = Array.isArray(b.aliases) ? b.aliases : [];
    return Array.from(new Set(raw.map((a) => text(a).toLowerCase()).filter(Boolean)));
}

export function validateSite(data: unknown): { valid: boolean; errors: Record<string, string[]> } {
    const b = (data ?? {}) as Body;
    const errors: Record<string, string[]> = {};
    const fail = (field: string, message: string) => {
        (errors[field] ||= []).push(message);
    };

    const info = getType(text(b.type));
    if (!info) fail("type", "Choose a valid site type.");
    const type = info?.id ?? "";

    if (!Number.isInteger(Number(b.server_id)) || Number(b.server_id) < 1) {
        fail("server_id", "Choose a server.");
    }

    const domain = text(b.domain).toLowerCase();
    if (!DOMAIN.test(domain)) fail("domain", "Enter a valid domain, e.g. example.com.");

    const aliases = cleanAliases(b);
    if (aliases.length > 20) fail("aliases", "At most 20 aliases are allowed.");
    for (const a of aliases) {
        if (!DOMAIN.test(a)) fail("aliases", `"${a}" is not a valid domain.`);
        if (a === domain) fail("aliases", "An alias can't be the same as the domain.");
    }

    const user = deriveUser(b, domain);
    if (!USER.test(user) || RESERVED_USERS.includes(user)) {
        fail("isolated_user", "Use 1-32 lowercase letters, digits, - or _, starting with a letter (not a reserved name).");
    }

    if (type && isPhp(type) && !PHP_VERSIONS.includes(text(b.php_version))) {
        fail("php_version", "Choose a valid PHP version.");
    }

    if (type && needsPort(type)) {
        const raw = text(b.port);
        if (raw !== "" && raw !== "0") {
            const port = Number(raw);
            if (!Number.isInteger(port) || port < 1024 || port > 65535) {
                fail("port", "The app port must be between 1024 and 65535.");
            }
        }
    }

    const sourceControlId = Number(b.source_control_id) || 0;
    if (info?.usesRepository && sourceControlId !== 0) {
        const repo = text(b.repository);
        if (!REPO.test(repo) || repo.split("/").some((p) => p === "." || p === ".." || p.startsWith("-"))) {
            fail("repository", "Pick a repository.");
        }
        const branch = text(b.branch) || "main";
        if (!BRANCH.test(branch) || branch.includes("..")) fail("branch", "That branch name isn't valid.");
    }

    for (const field of ["web_directory", "app_directory", "backend_directory"]) {
        if (badDir(cleanDir(b[field]))) fail(field, "Use a relative path like public or client.");
    }

    for (const field of ["build_command", "start_command"]) {
        const value = text(b[field]);
        if (value !== "" && !COMMAND.test(value)) fail(field, "Use a single line of up to 200 characters.");
    }

    return { valid: Object.keys(errors).length === 0, errors };
}

export function normalizeSite(data: unknown): NormalizedSite {
    const b = (data ?? {}) as Body;
    const type = text(b.type);
    const info = getType(type);
    const d = info?.defaults;
    const domain = text(b.domain).toLowerCase();

    const sourceControlId = info?.usesRepository ? Number(b.source_control_id) || 0 : 0;
    const pick = (value: string, fallback: string | undefined) => (value !== "" ? value : (fallback ?? ""));

    return {
        server_id: Number(b.server_id),
        source_control_id: sourceControlId,
        type,
        domain,
        aliases: cleanAliases(b),
        isolated_user: deriveUser(b, domain),
        php_version: info && info.runtime === "php" ? text(b.php_version) : "",
        port: needsPort(type) ? Number(text(b.port)) || 0 : 0,
        repository: sourceControlId !== 0 ? text(b.repository) : "",
        branch: sourceControlId !== 0 ? text(b.branch) || "main" : "",
        web_directory: pick(cleanDir(b.web_directory), d?.web_directory),
        app_directory: pick(cleanDir(b.app_directory), d?.app_directory),
        backend_directory: pick(cleanDir(b.backend_directory), d?.backend_directory),
        build_command: pick(text(b.build_command), d?.build_command),
        start_command: pick(text(b.start_command), d?.start_command),
        install_deps: b.install_deps !== false,
    };
}
