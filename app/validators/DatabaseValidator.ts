/**
 * Names end up inside SQL run as the MySQL root account, so the patterns are
 * strict on purpose: lowercase letters, digits and underscores only. That also
 * means no value can ever contain a quote or a backtick.
 */

const DB_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const DB_USER = /^[a-z][a-z0-9_]{0,31}$/; // MySQL 8.4 caps user names at 32

const RESERVED_DATABASES = ["mysql", "sys", "information_schema", "performance_schema"];
const RESERVED_USERS = ["root", "mysql", "debian_sys_maint", "mysql_session", "mysql_sys", "mysql_infoschema"];

/** Returns an error message, or null when the name is fine. */
export function checkDatabaseName(name: string): string | null {
    if (!DB_NAME.test(name)) {
        return "Use 1-64 lowercase letters, digits or underscores, starting with a letter.";
    }
    if (RESERVED_DATABASES.includes(name)) {
        return "That name is reserved by MySQL.";
    }
    return null;
}

/** Returns an error message, or null when the name is fine. */
export function checkDbUserName(name: string): string | null {
    if (!DB_USER.test(name)) {
        return "Use 1-32 lowercase letters, digits or underscores, starting with a letter.";
    }
    if (RESERVED_USERS.includes(name)) {
        return "That name is reserved.";
    }
    return null;
}

/** Allowed character sets and the collations that belong to each. First one is the default. */
export const COLLATIONS: Record<string, string[]> = {
    utf8mb4: ["utf8mb4_unicode_ci", "utf8mb4_general_ci", "utf8mb4_0900_ai_ci", "utf8mb4_bin"],
    latin1: ["latin1_swedish_ci", "latin1_general_ci"],
};

export const DEFAULT_CHARSET = "utf8mb4";
export const DEFAULT_COLLATION = "utf8mb4_unicode_ci";

/** Returns an error message, or null when the pair is allowed. */
export function checkCharset(charset: string, collation: string): string | null {
    const allowed = COLLATIONS[charset];
    if (!allowed) return "Choose a valid character set.";
    if (!allowed.includes(collation)) return "That collation doesn't belong to the chosen character set.";
    return null;
}