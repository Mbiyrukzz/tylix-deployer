/**
 * Runs MySQL user and database changes on a server over SSH.
 *
 * Commands run as the server's MySQL root account over the local socket
 * (`sudo mysql`), so no MySQL root password is stored or needed. Each call is
 * one short SSH command; nothing here throws on a MySQL or SSH failure, it
 * returns { ok: false, error } with a readable message instead.
 *
 * Safety: SQL is sent base64-encoded on stdin (no shell quoting), and every
 * name and password is re-checked against a strict pattern right before it is
 * placed in a statement, even though the routes validate them first.
 *
 * Accounts are 'name'@'localhost'. MySQL treats TCP connections to 127.0.0.1
 * as host "localhost", so apps on the same server (DB_HOST=127.0.0.1) match.
 */

import { randomBytes } from "node:crypto";
import { sshExec, type SshTarget } from "./Ssh.js";

export interface DbResult {
    ok: boolean;
    error: string;
}

const TIMEOUT_MS = 30_000;
const HOST = "localhost";

const SAFE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_SECRET = /^[A-Za-z0-9_-]{8,128}$/;

const PRELUDE = `set -euo pipefail
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo -n"; fi
command -v mysql >/dev/null 2>&1 || { echo "MySQL is not installed on this server. Install it from the Packages page, then try again." >&2; exit 1; }
$SUDO systemctl is-active --quiet mysql || { echo "MySQL is not running on this server." >&2; exit 1; }
`;

function safe(value: string, pattern: RegExp, what: string): string {
    if (!pattern.test(value)) throw new Error(`Unsafe ${what}.`);
    return value;
}

const ident = (name: string) => `\`${safe(name, SAFE_NAME, "name")}\``;
const account = (user: string) => `'${safe(user, SAFE_NAME, "user name")}'@'${HOST}'`;
// "_" is a wildcard in GRANT/REVOKE database names; escape it so the grant
// matches exactly this database and not look-alikes.
const grantTarget = (db: string) => `\`${safe(db, SAFE_NAME, "name").replace(/_/g, "\\_")}\`.*`;

/** A shell variable holding base64 SQL, and the command that feeds it to mysql. */
const sqlVar = (name: string, sql: string) => `${name}='${Buffer.from(sql, "utf8").toString("base64")}'\n`;
const mysql = (name: string) => `printf %s "$${name}" | base64 -d | $SUDO mysql`;

function failure(output: string, secrets: string[]): string {
    let text = output;
    for (const secret of secrets) {
        if (secret) text = text.split(secret).join("***");
    }
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1] ?? "The command failed.";
    return last.replace(/^ERROR \d+ \([A-Z0-9]+\)( at line \d+)?: /, "").slice(0, 300);
}

async function run(target: SshTarget, body: string, secrets: string[] = []): Promise<DbResult> {
    const encoded = Buffer.from(PRELUDE + body, "utf8").toString("base64");
    const command = `bash -c "$(echo ${encoded} | base64 -d)" </dev/null 2>&1`;

    const result = await sshExec(target, command, TIMEOUT_MS);
    if (result.code === 0) return { ok: true, error: "" };

    const output = (result.stdout || result.stderr || "").trim();
    return {
        ok: false,
        error: output ? failure(output, secrets) : "Couldn't reach the server. Check that it is online.",
    };
}

/** 32 URL-safe characters: letters, digits, "-" and "_" (nothing that needs escaping). */
export function generatePassword(): string {
    return randomBytes(24).toString("base64url");
}

export class DatabaseManager {
    static createUser(target: SshTarget, user: string, password: string): Promise<DbResult> {
        safe(password, SAFE_SECRET, "password");
        const sql = `CREATE USER ${account(user)} IDENTIFIED BY '${password}';`;
        return run(target, sqlVar("SQL", sql) + mysql("SQL") + "\n", [password]);
    }

    static setPassword(target: SshTarget, user: string, password: string): Promise<DbResult> {
        safe(password, SAFE_SECRET, "password");
        const sql = `ALTER USER ${account(user)} IDENTIFIED BY '${password}';`;
        return run(target, sqlVar("SQL", sql) + mysql("SQL") + "\n", [password]);
    }

    static dropUser(target: SshTarget, user: string): Promise<DbResult> {
        const sql = `DROP USER IF EXISTS ${account(user)};`;
        return run(target, sqlVar("SQL", sql) + mysql("SQL") + "\n");
    }

    /**
     * Creates the database, then grants the owner full access to it only.
     * If the grant fails, the database this call just created is dropped again.
     * (If CREATE fails because the name exists, nothing is dropped.)
     */
    static createDatabase(
        target: SshTarget,
        db: string,
        user: string,
        charset = "utf8mb4",
        collation = "utf8mb4_unicode_ci",
    ): Promise<DbResult> {
        const cs = safe(charset, SAFE_NAME, "character set");
        const co = safe(collation, SAFE_NAME, "collation");
        const create = `CREATE DATABASE ${ident(db)} CHARACTER SET ${cs} COLLATE ${co};`;
        const grant = `GRANT ALL PRIVILEGES ON ${grantTarget(db)} TO ${account(user)};`;
        const undo = `DROP DATABASE IF EXISTS ${ident(db)};`;

        const body =
            sqlVar("CREATE", create) +
            sqlVar("GRANT", grant) +
            sqlVar("UNDO", undo) +
            `${mysql("CREATE")}
if ! ${mysql("GRANT")}; then
  ${mysql("UNDO")} >/dev/null 2>&1 || true
  exit 1
fi
`;
        return run(target, body);
    }

    /** Drops the database (even if it is already gone) and revokes the owner's grant. */
    static dropDatabase(target: SshTarget, db: string, user: string | null): Promise<DbResult> {
        const drop = `DROP DATABASE IF EXISTS ${ident(db)};`;
        let body = sqlVar("DROP", drop) + `${mysql("DROP")}\n`;

        if (user) {
            const revoke = `REVOKE ALL PRIVILEGES ON ${grantTarget(db)} FROM ${account(user)};`;
            // Best effort: the grant or the user may already be gone.
            body += sqlVar("REVOKE", revoke) + `${mysql("REVOKE")} >/dev/null 2>&1 || true\n`;
        }

        return run(target, body);
    }
}