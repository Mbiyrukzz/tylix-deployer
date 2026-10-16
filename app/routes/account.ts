/**
 * Account routes (the signed-in user only).
 *
 * GET    /api/account                              profile + two-factor status (authenticator and SMS)
 * PUT    /api/account                              change name
 * PUT    /api/account/password                     change password (needs the current one)
 * POST   /api/account/sign-out-everywhere          revoke every refresh token, clear cookies
 * POST   /api/account/two-factor/setup             start setup, returns secret + otpauth URI
 * POST   /api/account/two-factor/confirm           prove the app works, turns 2FA on, returns recovery codes once
 * POST   /api/account/two-factor/disable           needs password + a code
 * POST   /api/account/two-factor/recovery-codes    new set of codes, needs password + a code
 * POST   /api/account/two-factor/sms/setup         needs phone + password, texts a code
 * POST   /api/account/two-factor/sms/confirm       proves the phone, turns text-message codes on
 * POST   /api/account/two-factor/sms/send-code     resend during setup, or a code before turning SMS off
 * POST   /api/account/two-factor/sms/disable       needs password + a code from any method that is on
 *
 * Password-checking endpoints share one per-user limiter so a stolen
 * session can't be used to guess the current password.
 *
 * Changing the password signs the user out everywhere (including this
 * device), the same as the reset flow: access tokens already issued
 * still work until they expire (15 minutes by default).
 */

import type { Router } from "@tylix/core";
import type { TylixRequest, TylixResponse } from "@tylix/core";
import { createRateLimiter } from "@tylix/core";
import { verifyPassword, clearAuthCookies } from "@tylix/auth";
import { User } from "../models/User.js";
import type { UserAttributes } from "../models/User.js";
import { RefreshToken } from "../models/RefreshToken.js";
import { UserTwoFactor } from "../models/UserTwoFactor.js";
import { CryptoService } from "../services/CryptoService.js";
import { TwoFactorService } from "../services/TwoFactorService.js";
import { SmsTwoFactorService } from "../services/SmsTwoFactorService.js";
import type { SendResult } from "../services/SmsTwoFactorService.js";

type Handler = Parameters<Router["get"]>[1];
type FieldErrors = Record<string, string[]>;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

// In-memory, per server process (same as the auth limiters).
const limiter = createRateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

/** Answers 429 itself and returns true when the caller is over the limit. */
function throttled(req: TylixRequest, res: TylixResponse): boolean {
    const limit = limiter(String(req.user?.userId));
    if (limit.allowed) return false;

    res.status(429);
    res.json({ error: `Too many attempts. Try again in ${limit.retryAfterSeconds} seconds.` });
    return true;
}

/** Loads the signed-in user and answers 404 itself if they are gone. */
async function currentUser(req: TylixRequest, res: TylixResponse): Promise<UserAttributes | null> {
    const user = await User.find(req.user!.userId as number);
    if (!user) {
        res.status(404);
        res.json({ error: "Account not found." });
        return null;
    }
    return user;
}

function fail(res: TylixResponse, errors: FieldErrors) {
    res.status(422);
    return res.json({ errors });
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/** Answers for a failed text-message send: 429 for cooldown/cap, 503 if SMS isn't configured, 502 if the provider failed. */
function smsFailure(res: TylixResponse, sent: Extract<SendResult, { ok: false }>) {
    const status = sent.reason === "cooldown" || sent.reason === "limit" ? 429 : sent.reason === "not_configured" ? 503 : 502;
    res.status(status);
    return res.json({ error: sent.message });
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    router.get(
        "/api/account",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;

            const tf = await TwoFactorService.find(user.id);
            const enabled = Boolean(tf?.confirmed_at);

            return res.json({
                user: User.toSafeObject(user),
                two_factor: {
                    enabled,
                    recovery_codes_remaining: enabled && tf ? TwoFactorService.recoveryRemaining(tf) : 0,
                    sms: await SmsTwoFactorService.summary(user.id),
                },
            });
        }),
    );

    router.put(
        "/api/account",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;

            const name = text(req.body?.name).trim();
            if (!name) return fail(res, { name: ["Name is required."] });
            if (name.length > 100) return fail(res, { name: ["Name must be at most 100 characters."] });

            // Only the name is accepted here. Email changes need a re-verification
            // flow, and email_verified_at must never come from a request body.
            await User.update(user.id, { name });
            const fresh = await User.find(user.id);

            return res.json({ user: User.toSafeObject(fresh) });
        }),
    );

    router.put(
        "/api/account/password",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;
            if (throttled(req, res)) return;

            const current = text(req.body?.current_password);
            const next = text(req.body?.password);
            const confirmation = text(req.body?.password_confirmation);

            const errors: FieldErrors = {};
            if (!current) errors.current_password = ["Enter your current password."];
            if (!next) errors.password = ["Enter a new password."];
            else if (next.length < MIN_PASSWORD_LENGTH) {
                errors.password = [`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`];
            } else if (next.length > MAX_PASSWORD_LENGTH) {
                errors.password = [`Password must be at most ${MAX_PASSWORD_LENGTH} characters.`];
            } else if (next === current) {
                errors.password = ["Your new password must be different from the current one."];
            }
            if (!errors.password && next !== confirmation) {
                errors.password_confirmation = ["The two passwords don't match."];
            }
            if (Object.keys(errors).length > 0) return fail(res, errors);

            if (!(await verifyPassword(current, user.password))) {
                return fail(res, { current_password: ["That isn't your current password."] });
            }

            await User.updatePassword(user.id, next);
            await RefreshToken.revokeAllForUser(user.id);
            clearAuthCookies(res);

            return res.json({ ok: true, message: "Password updated. Please log in again." });
        }),
    );

    router.post(
        "/api/account/sign-out-everywhere",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;

            await RefreshToken.revokeAllForUser(user.id);
            clearAuthCookies(res);

            return res.json({ ok: true });
        }),
    );

    // ---------------------------------------------------------------- two-factor (authenticator app)

    router.post(
        "/api/account/two-factor/setup",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;

            const existing = await TwoFactorService.find(user.id);
            if (existing?.confirmed_at) {
                res.status(409);
                return res.json({ error: "Two-factor authentication is already on." });
            }

            const secret = TwoFactorService.generateSecret();
            const encrypted = CryptoService.encrypt(secret);

            // Starting again before confirming just replaces the unconfirmed secret.
            if (existing) {
                await UserTwoFactor.update(existing.id, { secret: encrypted, last_step: 0 });
            } else {
                await UserTwoFactor.create({
                    user_id: user.id,
                    secret: encrypted,
                    recovery_codes: "[]",
                    last_step: 0,
                });
            }

            return res.json({ secret, uri: TwoFactorService.uri(user.email, secret) });
        }),
    );

    router.post(
        "/api/account/two-factor/confirm",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;
            if (throttled(req, res)) return;

            const row = await TwoFactorService.find(user.id);
            if (!row) {
                res.status(409);
                return res.json({ error: "Start setup first." });
            }
            if (row.confirmed_at) {
                res.status(409);
                return res.json({ error: "Two-factor authentication is already on." });
            }

            const code = text(req.body?.code);
            if (!code.trim()) return fail(res, { code: ["Enter the 6-digit code from your app."] });

            const step = TwoFactorService.verifyTotp(CryptoService.decrypt(row.secret), code, 0);
            if (step === null) {
                return fail(res, { code: ["That code didn't match. Check your phone's clock and try again."] });
            }

            const codes = TwoFactorService.generateRecoveryCodes();
            await UserTwoFactor.update(row.id, {
                confirmed_at: new Date().toISOString(),
                recovery_codes: JSON.stringify(codes.hashed),
                last_step: step,
            });

            return res.json({ ok: true, recovery_codes: codes.plain });
        }),
    );

    /** Shared by disable and regenerate: password, then a code, both required. */
    async function reauthenticate(req: TylixRequest, res: TylixResponse, user: UserAttributes): Promise<boolean> {
        if (throttled(req, res)) return false;

        const password = text(req.body?.password);
        if (!password) {
            fail(res, { password: ["Enter your password."] });
            return false;
        }
        if (!(await verifyPassword(password, user.password))) {
            fail(res, { password: ["That isn't your password."] });
            return false;
        }

        const result = await TwoFactorService.challenge(user.id, req.body?.code);
        if (result === "not_enabled") {
            res.status(409);
            res.json({ error: "Two-factor authentication isn't on." });
            return false;
        }
        if (result === "missing") {
            fail(res, { code: ["Enter a code from your app, or a recovery code."] });
            return false;
        }
        if (result === "invalid") {
            fail(res, { code: ["That code isn't valid."] });
            return false;
        }
        return true;
    }

    router.post(
        "/api/account/two-factor/disable",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;
            if (!(await reauthenticate(req, res, user))) return;

            const row = await TwoFactorService.find(user.id);
            if (row) await UserTwoFactor.delete(row.id);

            return res.json({ ok: true });
        }),
    );

    router.post(
        "/api/account/two-factor/recovery-codes",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;
            if (!(await reauthenticate(req, res, user))) return;

            const row = await TwoFactorService.find(user.id);
            if (!row) {
                res.status(409);
                return res.json({ error: "Two-factor authentication isn't on." });
            }

            const codes = TwoFactorService.generateRecoveryCodes();
            await UserTwoFactor.update(row.id, { recovery_codes: JSON.stringify(codes.hashed) });

            return res.json({ ok: true, recovery_codes: codes.plain });
        }),
    );

    // ---------------------------------------------------------------- two-factor (text message)

    router.post(
        "/api/account/two-factor/sms/setup",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;
            if (throttled(req, res)) return;

            const phone = SmsTwoFactorService.normalizePhone(req.body?.phone);
            const password = text(req.body?.password);

            const errors: FieldErrors = {};
            if (!phone) errors.phone = ["Enter a valid mobile number, like 0712345678 or +254712345678."];
            if (!password) errors.password = ["Enter your password."];
            else if (!(await verifyPassword(password, user.password))) errors.password = ["That isn't your password."];
            if (!phone || Object.keys(errors).length > 0) return fail(res, errors);

            const existing = await SmsTwoFactorService.find(user.id);
            if (existing?.confirmed_at) {
                res.status(409);
                return res.json({ error: "Text-message codes are already on. Turn them off first to use a different number." });
            }

            const row = await SmsTwoFactorService.prepare(user.id, phone);
            const sent = await SmsTwoFactorService.sendCode(row);
            if (!sent.ok) return smsFailure(res, sent);

            return res.json({ ok: true, phone_hint: SmsTwoFactorService.maskPhone(row.phone) });
        }),
    );

    router.post(
        "/api/account/two-factor/sms/confirm",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;
            if (throttled(req, res)) return;

            const row = await SmsTwoFactorService.find(user.id);
            if (!row || row.confirmed_at || !row.phone) {
                res.status(409);
                return res.json({ error: "Start the text-message setup first." });
            }

            const code = text(req.body?.code);
            if (!code.trim()) return fail(res, { code: ["Enter the 6-digit code we texted you."] });

            if (!(await SmsTwoFactorService.verifyCode(row, code))) {
                return fail(res, { code: ["That code is incorrect or has expired."] });
            }

            await SmsTwoFactorService.markConfirmed(row.id);
            return res.json({ ok: true, phone_hint: SmsTwoFactorService.maskPhone(row.phone) });
        }),
    );

    // Resend during setup, or get a code before turning SMS off.
    // SmsTwoFactorService.sendCode enforces the 60 s cooldown and the hourly cap.
    router.post(
        "/api/account/two-factor/sms/send-code",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;

            const row = await SmsTwoFactorService.find(user.id);
            if (!row || !row.phone) {
                res.status(409);
                return res.json({ error: "Text-message codes aren't set up." });
            }

            const sent = await SmsTwoFactorService.sendCode(row);
            if (!sent.ok) return smsFailure(res, sent);

            return res.json({ ok: true, phone_hint: SmsTwoFactorService.maskPhone(row.phone) });
        }),
    );

    router.post(
        "/api/account/two-factor/sms/disable",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;
            if (throttled(req, res)) return;

            const row = await SmsTwoFactorService.find(user.id);
            if (!row?.confirmed_at) {
                res.status(409);
                return res.json({ error: "Text-message codes aren't turned on." });
            }

            const password = text(req.body?.password);
            if (!password) return fail(res, { password: ["Enter your password."] });
            if (!(await verifyPassword(password, user.password))) {
                return fail(res, { password: ["That isn't your password."] });
            }

            // Any method that is on works: authenticator code, recovery code or a texted code.
            const check = await TwoFactorService.loginChallenge(user.id, req.body?.code);
            if (check.result !== "ok") return fail(res, { code: ["That code isn't valid."] });

            await SmsTwoFactorService.reset(row.id);
            return res.json({ ok: true });
        }),
    );
}