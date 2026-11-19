/**
 * Account routes (the signed-in user only).
 *
 * GET    /api/account                              profile + two-factor status (authenticator and SMS)
 * PUT    /api/account                              change name
 * PUT    /api/account/avatar                       new profile picture ({ image: "data:image/webp;base64,..." })
 * DELETE /api/account/avatar                       remove the profile picture
 * GET    /api/avatars/:userId/:hash                a profile picture (public: the hash is the key)
 * PUT    /api/account/password                     change password (needs the current one)
 * POST   /api/account/sign-out-everywhere          end every session (all devices), clear cookies
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
 * A new password follows the same rules as registration and reset
 * (PasswordPolicy) and is checked against known breaches.
 *
 * Changing the password signs the user out everywhere (including this
 * device), the same as the reset flow. Access ends at once: requireAuth
 * checks that a token's session still exists (Tylix 2 session guard).
 */

import type { Router } from "@tylix/core";
import type { TylixRequest, TylixResponse } from "@tylix/core";
import { createRateLimiter } from "@tylix/core";
import { verifyPassword, applyCookies } from "@tylix/auth";
import { User } from "../models/User.js";
import type { UserAttributes } from "../models/User.js";
import { authController } from "../controllers/AuthController.js";
import { UserTwoFactor } from "../models/UserTwoFactor.js";
import { UserAvatar } from "../models/UserAvatar.js";
import { createHash } from "node:crypto";
import { CryptoService } from "../services/CryptoService.js";
import { TwoFactorService } from "../services/TwoFactorService.js";
import { SmsTwoFactorService } from "../services/SmsTwoFactorService.js";
import type { SendResult } from "../services/SmsTwoFactorService.js";
import { PasswordBreachService } from "../services/PasswordBreachService.js";
import { passwordProblem } from "../validators/PasswordPolicy.js";

type Handler = Parameters<Router["get"]>[1];
type FieldErrors = Record<string, string[]>;

const BREACH_MESSAGE =
    "That password has appeared in a known data breach. Please choose a different one.";

// In-memory, per server process (same as the auth limiters).
const limiter = createRateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

const avatarLimiter = createRateLimiter({ max: 30, windowMs: 15 * 60 * 1000 });

// Profile pictures arrive resized to 256x256 by the browser (Settings ->
// Account), so they are small. The cap leaves room for a PNG with detail.
const AVATAR_MAX_BYTES = 400 * 1024;
const AVATAR_TYPES: Record<string, { ext: string; matches: (b: Buffer) => boolean }> = {
    "image/png": { ext: "png", matches: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 },
    "image/jpeg": { ext: "jpg", matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    "image/webp": {
        ext: "webp",
        matches: (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP",
    },
};

/** The decoded image from a data URL, or an error message for the person. */
function readAvatar(value: unknown): { mime: string; bytes: Buffer } | { error: string } {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(text(value));
    if (!match) return { error: "Choose a PNG, JPEG or WebP image." };

    const mime = match[1];
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0) return { error: "That image is empty." };
    if (bytes.length > AVATAR_MAX_BYTES) return { error: "That image is too large. Try a smaller one." };
    // The bytes must really be the type the browser claimed.
    if (!AVATAR_TYPES[mime].matches(bytes)) return { error: "That file isn't a valid image." };
    return { mime, bytes };
}

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

/** Ends every session of the user (this browser too) and clears its cookies. */
async function endEverySession(req: TylixRequest, res: TylixResponse, userId: number): Promise<void> {
    const { auth } = authController();
    await auth.revokeAllSessions(userId);
    applyCookies(res, auth.clearCookies(req));
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
        "/api/account/avatar",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;

            const limit = avatarLimiter(String(user.id));
            if (!limit.allowed) {
                res.status(429);
                return res.json({ error: `Too many uploads. Try again in ${limit.retryAfterSeconds} seconds.` });
            }

            const image = readAvatar(req.body?.image);
            if ("error" in image) return fail(res, { image: [image.error] });

            const hash = createHash("sha256").update(image.bytes).digest("hex").slice(0, 16);
            const data = image.bytes.toString("base64");
            const existing = await UserAvatar.forUser(user.id);
            if (existing) {
                await UserAvatar.update(existing.id, { mime: image.mime, hash, data });
            } else {
                await UserAvatar.create({ user_id: user.id, mime: image.mime, hash, data });
            }
            await User.update(user.id, { avatar_hash: hash });

            return res.json({ user: User.toSafeObject(await User.find(user.id)) });
        }),
    );

    router.delete(
        "/api/account/avatar",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;

            const existing = await UserAvatar.forUser(user.id);
            if (existing) await UserAvatar.delete(existing.id);
            await User.update(user.id, { avatar_hash: null });

            return res.json({ user: User.toSafeObject(await User.find(user.id)) });
        }),
    );

    // Public on purpose: <img> tags can't wait for a token refresh. The
    // content hash in the URL is the key (64 bits, not guessable), and a
    // replaced or removed picture stops answering at its old URL.
    router.get("/api/avatars/:userId/:hash", async (req, res) => {
        const userId = Number(req.params.userId);
        const hash = String(req.params.hash ?? "");
        const row = Number.isInteger(userId) && /^[0-9a-f]{16}$/.test(hash) ? await UserAvatar.forUser(userId) : null;

        if (!row || row.hash !== hash || !AVATAR_TYPES[row.mime]) {
            res.status(404);
            return res.json({ error: "Not found." });
        }

        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        return res.download(Buffer.from(row.data, "base64"), `avatar.${AVATAR_TYPES[row.mime].ext}`, {
            inline: true,
            type: row.mime,
        });
    });

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

            if (!next) {
                errors.password = ["Enter a new password."];
            } else {
                // Same rules as registration and reset: length, letter, number,
                // symbol, banned fragments, and no part of the email or name.
                const problem = passwordProblem(next, { email: user.email, name: user.name });
                if (problem) {
                    errors.password = [problem];
                } else if (next === current) {
                    errors.password = ["Your new password must be different from the current one."];
                }
            }

            if (!errors.password && next !== confirmation) {
                errors.password_confirmation = ["The two passwords don't match."];
            }
            if (Object.keys(errors).length > 0) return fail(res, errors);

            if (!(await verifyPassword(current, user.password))) {
                return fail(res, { current_password: ["That isn't your current password."] });
            }

            // After the current password is verified, so this call can't be
            // used by someone without it, and no lookup is spent on a bad request.
            if (await PasswordBreachService.isBreached(next)) {
                return fail(res, { password: [BREACH_MESSAGE] });
            }

            await User.updatePassword(user.id, next);
            await endEverySession(req, res, user.id);

            return res.json({ ok: true, message: "Password updated. Please log in again." });
        }),
    );

    router.post(
        "/api/account/sign-out-everywhere",
        auth(async (req, res) => {
            const user = await currentUser(req, res);
            if (!user) return;

            await endEverySession(req, res, user.id);

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