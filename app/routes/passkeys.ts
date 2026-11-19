/**
 * Passkeys (WebAuthn): add them in Settings -> Two-factor, sign in with one
 * on the login page. The checks live in app/services/PasskeyService.ts.
 *
 * Signed in:
 * GET    /api/account/passkeys               this user's passkeys
 * POST   /api/account/passkeys/options       { password } -> options for navigator.credentials.create()
 * POST   /api/account/passkeys               { credential, name } -> saves the new passkey
 * PUT    /api/account/passkeys/:id           { name } -> rename
 * DELETE /api/account/passkeys/:id           remove
 *
 * Public:
 * POST   /api/auth/passkey/options           -> { request_id, options } for navigator.credentials.get()
 * POST   /api/auth/passkey/login             { request_id, credential, remember } -> signs in
 *
 * Challenges live in the app's store for 5 minutes and work once. A passkey
 * must verify the user (biometrics or PIN), so signing in with one counts as
 * two factors: no authenticator or SMS code is asked for.
 */

import type { Router, TylixRequest, TylixResponse } from "@tylix/core";
import { createRateLimiter, getStore } from "@tylix/core";
import { verifyPassword, applyCookies } from "@tylix/auth";
import { randomBytes } from "node:crypto";
import { User } from "../models/User.js";
import { UserPasskey } from "../models/UserPasskey.js";
import type { UserPasskeyAttributes } from "../models/UserPasskey.js";
import { authController } from "../controllers/AuthController.js";
import {
    PasskeyError,
    SUPPORTED_ALGORITHMS,
    credentialIdOf,
    newChallenge,
    newUserHandle,
    relyingParty,
    verifyAssertion,
    verifyRegistration,
} from "../services/PasskeyService.js";
import type { AssertionInput, RegistrationInput } from "../services/PasskeyService.js";

type Handler = Parameters<Router["get"]>[1];

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PASSKEYS = 20;

// Adding a passkey checks the password: shares nothing with account.ts on
// purpose, but uses the same budget (10 per 15 minutes per user).
const passwordLimiter = createRateLimiter({ name: "passkey-password", max: 10, windowMs: 15 * 60 * 1000, store: "shared" });
const loginIpLimiter = createRateLimiter({ name: "passkey-login-ip", max: 60, windowMs: 15 * 60 * 1000, store: "shared" });

function clientIp(req: TylixRequest): string {
    return (req as unknown as { ip?: string }).ip ?? "unknown";
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function tooMany(res: TylixResponse, seconds: number) {
    res.setHeader("Retry-After", String(seconds));
    res.status(429);
    return res.json({ error: `Too many attempts. Try again in ${seconds} seconds.` });
}

function failed(res: TylixResponse, err: unknown, status = 400) {
    if (err instanceof PasskeyError) {
        res.status(status);
        return res.json({ error: err.message });
    }
    throw err;
}

/** What the settings page shows: never the key itself. */
function present(row: UserPasskeyAttributes) {
    let transports: string[] = [];
    try {
        const parsed = JSON.parse(row.transports || "[]");
        transports = Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
    } catch {
        transports = [];
    }
    return {
        id: row.id,
        name: row.name,
        synced: Boolean(Number(row.backed_up)),
        transports,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
    };
}

function cleanName(value: unknown, fallback: string): string {
    const name = text(value).replace(/\s+/g, " ").trim().slice(0, 60);
    return name || fallback;
}

async function takeChallenge<T>(key: string): Promise<T | null> {
    const store = getStore();
    const value = await store.get<T>(key);
    if (value !== null) await store.delete(key);
    return value;
}

export async function routes(router: Router, { auth }: { auth: (handler: Handler) => Handler }) {
    // ------------------------------------------------------------ settings

    router.get(
        "/api/account/passkeys",
        auth(async (req, res) => {
            const rows = await UserPasskey.forUser(Number(req.user!.userId));
            return res.json({ passkeys: rows.map(present) });
        }),
    );

    router.post(
        "/api/account/passkeys/options",
        auth(async (req, res) => {
            const userId = Number(req.user!.userId);
            const user = await User.find(userId);
            if (!user) return res.status(404).json({ error: "Account not found." });

            const limit = await passwordLimiter(String(userId));
            if (!limit.allowed) return tooMany(res, limit.retryAfterSeconds);

            const password = text(req.body?.password);
            if (!password) return res.status(422).json({ errors: { password: ["Enter your password."] } });
            if (!(await verifyPassword(password, user.password))) {
                return res.status(422).json({ errors: { password: ["That isn't your password."] } });
            }

            const existing = await UserPasskey.forUser(userId);
            if (existing.length >= MAX_PASSKEYS) {
                return res.status(409).json({ error: `You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.` });
            }

            const rp = relyingParty(req);
            const challenge = newChallenge();
            const handle = existing[0]?.user_handle || newUserHandle();
            await getStore().set(`passkey:reg:${userId}`, { challenge, handle }, { ttlMs: CHALLENGE_TTL_MS });

            return res.json({
                options: {
                    challenge,
                    rp: { id: rp.id, name: rp.name },
                    user: { id: handle, name: user.email, displayName: user.name || user.email },
                    pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
                    timeout: CHALLENGE_TTL_MS,
                    attestation: "none",
                    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
                    excludeCredentials: existing.map((p) => ({ type: "public-key", id: p.credential_id })),
                },
            });
        }),
    );

    router.post(
        "/api/account/passkeys",
        auth(async (req, res) => {
            const userId = Number(req.user!.userId);
            const pending = await takeChallenge<{ challenge: string; handle: string }>(`passkey:reg:${userId}`);
            if (!pending) return res.status(409).json({ error: "This request expired. Start again." });

            let verified;
            try {
                verified = verifyRegistration(req.body?.credential as RegistrationInput, pending.challenge, relyingParty(req));
            } catch (err) {
                return failed(res, err);
            }

            if (await UserPasskey.byCredential(verified.credentialId)) {
                return res.status(409).json({ error: "That passkey is already added." });
            }

            const count = (await UserPasskey.forUser(userId)).length;
            const row = (await UserPasskey.create({
                user_id: userId,
                credential_id: verified.credentialId,
                user_handle: pending.handle,
                public_key: verified.publicKey,
                algorithm: verified.algorithm,
                sign_count: verified.signCount,
                name: cleanName(req.body?.name, `Passkey ${count + 1}`),
                transports: JSON.stringify(verified.transports),
                aaguid: verified.aaguid,
                backed_up: verified.backedUp,
                last_used_at: null,
            })) as UserPasskeyAttributes | null;
            if (!row) return res.status(500).json({ error: "Couldn't save the passkey." });

            return res.json({ passkey: present(row) });
        }),
    );

    /** The user's own passkey, or answers 404 itself. */
    async function ownPasskey(req: TylixRequest, res: TylixResponse): Promise<UserPasskeyAttributes | null> {
        const row = (await UserPasskey.find(Number(req.params.id))) as UserPasskeyAttributes | null;
        if (!row || Number(row.user_id) !== Number(req.user!.userId)) {
            res.status(404);
            res.json({ error: "Passkey not found." });
            return null;
        }
        return row;
    }

    router.put(
        "/api/account/passkeys/:id",
        auth(async (req, res) => {
            const row = await ownPasskey(req, res);
            if (!row) return;
            const name = cleanName(req.body?.name, "");
            if (!name) return res.status(422).json({ errors: { name: ["Give the passkey a name."] } });
            await UserPasskey.update(row.id, { name });
            return res.json({ passkey: present({ ...row, name }) });
        }),
    );

    router.delete(
        "/api/account/passkeys/:id",
        auth(async (req, res) => {
            const row = await ownPasskey(req, res);
            if (!row) return;
            await UserPasskey.delete(row.id);
            return res.json({ ok: true });
        }),
    );

    // ------------------------------------------------------------ sign-in

    router.post("/api/auth/passkey/options", async (req, res) => {
        const limit = await loginIpLimiter(clientIp(req));
        if (!limit.allowed) return tooMany(res, limit.retryAfterSeconds);

        const rp = relyingParty(req);
        const requestId = randomBytes(18).toString("base64url");
        const challenge = newChallenge();
        await getStore().set(`passkey:auth:${requestId}`, challenge, { ttlMs: CHALLENGE_TTL_MS });

        return res.json({
            request_id: requestId,
            options: { challenge, rpId: rp.id, timeout: CHALLENGE_TTL_MS, userVerification: "required", allowCredentials: [] },
        });
    });

    router.post("/api/auth/passkey/login", async (req, res) => {
        const limit = await loginIpLimiter(clientIp(req));
        if (!limit.allowed) return tooMany(res, limit.retryAfterSeconds);

        const requestId = text(req.body?.request_id);
        const challenge = /^[A-Za-z0-9_-]{10,64}$/.test(requestId) ? await takeChallenge<string>(`passkey:auth:${requestId}`) : null;
        if (!challenge) return res.status(409).json({ error: "This sign-in request expired. Try again." });

        const credential = req.body?.credential as AssertionInput;
        let row: UserPasskeyAttributes | null = null;
        try {
            row = await UserPasskey.byCredential(credentialIdOf(credential));
        } catch (err) {
            return failed(res, err);
        }
        if (!row) {
            return res.status(401).json({
                error: "This passkey isn't linked to an account here. It may have been removed: sign in with your password.",
                code: "PASSKEY_UNKNOWN",
            });
        }

        let result;
        try {
            result = verifyAssertion(credential, row, challenge, relyingParty(req));
        } catch (err) {
            return failed(res, err, 401);
        }

        const user = await User.find(row.user_id);
        if (!user) return res.status(401).json({ error: "That account no longer exists." });
        if (!User.isEmailVerified(user)) {
            return res.status(403).json({ error: "Please verify your email before logging in.", code: "EMAIL_NOT_VERIFIED" });
        }

        await UserPasskey.update(row.id, {
            sign_count: result.signCount,
            backed_up: result.backedUp || Boolean(Number(row.backed_up)),
            last_used_at: new Date().toISOString(),
        });

        const { cookies } = await authController().auth.signIn(req, user.id, { persistent: req.body?.remember !== false });
        applyCookies(res, cookies);
        return res.json({ user: User.toSafeObject(user) });
    });
}
