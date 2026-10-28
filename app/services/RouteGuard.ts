/**
 * Shared request guards for the deployer's controllers and routes.
 *
 * The same ideas as AuthController, for logged-in routes:
 *
 *   createGuard()        rate limit per user, team or IP (answers 429 itself)
 *   createFailureGate()  counts WRONG answers (passwords, codes, rejected
 *                        credentials) and locks the key out for a while once
 *                        too many pile up
 *   requireStepUp()      StepUpService.require() plus a lockout on wrong codes,
 *                        shared by every step-up action
 *   audit()              writes to the server log; a logging failure never
 *                        breaks the request
 *   stepUpCode()         the second-factor code the client sent
 *   clientIp()           the caller's address
 *
 * Like the limiters in AuthController these live in memory, per server process.
 */

import { createRateLimiter } from "@tylix/core";
import type { TylixRequest, TylixResponse } from "@tylix/core";
import { ServerLogService } from "./ServerLogService.js";
import { StepUpService } from "./StepUpService.js";

export function clientIp(req: TylixRequest): string {
    return (req as unknown as { ip?: string }).ip ?? "unknown";
}

/** The second-factor code the client sent: body first, then query string (DELETE requests). */
export function stepUpCode(req: TylixRequest): unknown {
    const fromBody = (req.body as { code?: unknown } | undefined)?.code;
    if (fromBody !== undefined && fromBody !== null && String(fromBody).trim() !== "") return fromBody;
    return req.query?.code;
}

type Scope = "user" | "team" | "ip";

function keyFor(req: TylixRequest, scope: Scope): string {
    if (scope === "ip") return `ip:${clientIp(req)}`;
    if (scope === "team") return `team:${String(req.user?.teamId ?? "none")}`;
    return `user:${String(req.user?.userId ?? clientIp(req))}`;
}

/** The key a failure gate uses for the caller. */
export function userKey(req: TylixRequest): string {
    return keyFor(req, "user");
}

function tooMany(res: TylixResponse, seconds: number, what: string) {
    const r = res as unknown as { setHeader?: (name: string, value: string) => void };
    if (typeof r.setHeader === "function") r.setHeader("Retry-After", String(seconds));

    res.status(429);
    return res.json({
        error: `Too many ${what}. Try again in ${seconds} seconds.`,
        code: "RATE_LIMITED",
        retry_after: seconds,
    });
}

/**
 * Rate limit for a route. Returns true to carry on, false after it has
 * answered 429 itself:
 *
 *   const guard = createGuard({ max: 20, windowMs: 60_000 });
 *   if (!guard(req, res)) return;
 */
export function createGuard(options: { max: number; windowMs: number; scope?: Scope; what?: string }) {
    const { max, windowMs, scope = "user", what = "requests" } = options;
    const limiter = createRateLimiter({ max, windowMs });

    return (req: TylixRequest, res: TylixResponse): boolean => {
        const result = limiter(keyFor(req, scope));
        if (result.allowed) return true;

        tooMany(res, result.retryAfterSeconds, what);
        return false;
    };
}

/**
 * Counts wrong answers. Once `max` of them land inside the window, the key
 * is locked out until the window (counted from the first failure) ends.
 *
 *   if (!gate.check(key, res)) return;          // before checking the answer
 *   if (!correct) { gate.fail(key); ... }       // wrong answer
 *   gate.clear(key);                            // right answer
 */
export function createFailureGate(options: { max: number; windowMs: number; what?: string }) {
    const { max, windowMs, what = "failed attempts" } = options;
    const entries = new Map<string, { count: number; resetAt: number }>();

    function live(key: string) {
        const entry = entries.get(key);
        if (!entry) return null;
        if (entry.resetAt <= Date.now()) {
            entries.delete(key);
            return null;
        }
        return entry;
    }

    return {
        /** Seconds until this key may try again; 0 when it may try now. */
        wait(key: string): number {
            const entry = live(key);
            return entry && entry.count >= max ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
        },

        fail(key: string): void {
            if (entries.size > 5000) {
                const now = Date.now();
                for (const [k, v] of entries) if (v.resetAt <= now) entries.delete(k);
            }

            const entry = live(key);
            if (entry) entry.count += 1;
            else entries.set(key, { count: 1, resetAt: Date.now() + windowMs });
        },

        clear(key: string): void {
            entries.delete(key);
        },

        /** True to carry on; false after it has answered 429 itself. */
        check(key: string, res: TylixResponse): boolean {
            const seconds = this.wait(key);
            if (seconds === 0) return true;

            tooMany(res, seconds, what);
            return false;
        },
    };
}

// One gate for every step-up action, so guessing a code on one action
// can't be continued on another.
const stepUpGate = createFailureGate({ max: 5, windowMs: 15 * 60_000, what: "wrong verification codes" });

/**
 * Second-factor check for a dangerous action. Same contract as
 * StepUpService.require: true means carry on, false means the answer (403
 * code needed, 422 wrong code) has already been sent.
 *
 * On top of that, a refusal while a code WAS sent means the code was wrong,
 * and that counts against the caller. Five wrong codes lock every step-up
 * action for 15 minutes. A request with no code (the first try that just
 * asks for one) is never counted.
 */
export async function requireStepUp(req: TylixRequest, res: TylixResponse, action: string): Promise<boolean> {
    const key = userKey(req);
    const code = stepUpCode(req);

    if (!stepUpGate.check(key, res)) return false;

    if (await StepUpService.require(req, res, code, action)) {
        stepUpGate.clear(key);
        return true;
    }

    if (code !== undefined && code !== null && String(code).trim() !== "") stepUpGate.fail(key);
    return false;
}

type LogEntry = Parameters<typeof ServerLogService.record>[0];

/** Writes a server log entry. Never throws: a log problem must not fail the action that was logged. */
export async function audit(entry: LogEntry): Promise<void> {
    try {
        await ServerLogService.record(entry);
    } catch (error) {
        console.error("[audit] couldn't write the log entry:", error instanceof Error ? error.message : error);
    }
}