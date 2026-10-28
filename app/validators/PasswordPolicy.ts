/**
 * One place for the password rules. Used for registration and password reset,
 * never for login (people with older passwords must still be able to sign in).
 * Keep the client copy in public/auth-ui.js in step with MIN/MAX.
 */

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

// Substrings that make "Password@2026!" style passwords trivially guessable.
const BANNED_FRAGMENTS = [
    "password",
    "passw0rd",
    "qwerty",
    "letmein",
    "welcome",
    "iloveyou",
    "admin",
    "tylix",
    "123456",
    "abc123",
];

export interface PasswordContext {
    email?: unknown;
    name?: unknown;
}

function joinWords(items: string[]): string {
    if (items.length <= 1) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Returns the first problem found, or null when the password is acceptable. */
export function passwordProblem(password: string, context: PasswordContext = {}): string | null {
    if (password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
        return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
    }

    const missing: string[] = [];
    if (!/\p{L}/u.test(password)) missing.push("a letter");
    if (!/\d/.test(password)) missing.push("a number");
    if (!/[^\p{L}\d\s]/u.test(password)) missing.push("a symbol");
    if (missing.length > 0) {
        return `Password must include ${joinWords(missing)}.`;
    }

    const lower = password.toLowerCase();
    if (BANNED_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
        return "That password is too easy to guess. Avoid common words and patterns.";
    }

    const emailLocal = String(context.email ?? "").toLowerCase().split("@")[0] ?? "";
    if (emailLocal.length >= 4 && lower.includes(emailLocal)) {
        return "Password must not contain your email address.";
    }

    for (const part of String(context.name ?? "").toLowerCase().split(/\s+/)) {
        if (part.length >= 4 && lower.includes(part)) {
            return "Password must not contain your name.";
        }
    }

    return null;
}