/**
 * Checks a password against the Have I Been Pwned range API using
 * k-anonymity: only the first 5 characters of the SHA-1 hash leave the
 * server, never the password. Fails OPEN (returns false) if the service is
 * slow or down, because a third-party outage shouldn't block sign-ups.
 */

import { createHash } from "node:crypto";

const TIMEOUT_MS = 2500;

export class PasswordBreachService {
    static async isBreached(password: string): Promise<boolean> {
        const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
        const prefix = hash.slice(0, 5);
        const suffix = hash.slice(5);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
                headers: { "Add-Padding": "true" },
                signal: controller.signal,
            });
            if (!response.ok) return false;

            const text = await response.text();
            for (const line of text.split("\n")) {
                const [candidate, count] = line.trim().split(":");
                // Padded rows have a count of 0 and are not real matches.
                if (candidate === suffix && Number(count) > 0) return true;
            }
            return false;
        } catch (error) {
            console.error("[breach-check] lookup failed, allowing password:", error);
            return false;
        } finally {
            clearTimeout(timer);
        }
    }
}