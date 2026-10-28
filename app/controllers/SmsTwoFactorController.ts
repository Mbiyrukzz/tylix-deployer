/**
 * Controller: SmsTwoFactorController
 *
 * Account-side management of the text-message factor. All routes need a
 * logged-in session (same middleware as /api/account/two-factor/*).
 *
 *   POST /api/account/two-factor/sms/setup      { phone, password }  -> sends a code
 *   POST /api/account/two-factor/sms/confirm    { code }             -> turns it on
 *   POST /api/account/two-factor/sms/send-code                       -> resend (setup) / code for turning off
 *   POST /api/account/two-factor/sms/disable    { password, code }   -> turns it off
 *
 * Hardening (same ideas as AuthController's login):
 *   - sending a text is rate limited per user (it costs money)
 *   - wrong passwords and wrong codes are counted per user and lock that
 *     user out for a while, so a stolen session can't guess either one
 *   - disable checks the password first and never touches the code check
 *     while the password is wrong
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { verifyPassword } from "@tylix/auth";
import { User } from "../models/User.js";
import { SmsTwoFactorService, type SendResult } from "../services/SmsTwoFactorService.js";
import { TwoFactorService } from "../services/TwoFactorService.js";
import { createGuard, createFailureGate } from "../services/RouteGuard.js";

const FIFTEEN_MINUTES = 15 * 60_000;

// Setup and resend both send a text.
const sendGuard = createGuard({ max: 6, windowMs: FIFTEEN_MINUTES, scope: "user", what: "text-message requests" });

// Shared by setup and disable: both ask for the account password.
const passwordGate = createFailureGate({ max: 5, windowMs: FIFTEEN_MINUTES, what: "wrong passwords" });

// Shared by confirm and disable: both ask for a code.
const codeGate = createFailureGate({ max: 5, windowMs: FIFTEEN_MINUTES, what: "wrong codes" });

function userIdOf(req: TylixRequest): number {
    return req.user!.userId as number;
}

const gateKey = (userId: number) => `user:${userId}`;

function bodyOf(req: TylixRequest): Record<string, any> {
    return (req.body ?? {}) as Record<string, any>;
}

async function passwordOk(userId: number, plain: unknown): Promise<boolean> {
    if (typeof plain !== "string" || !plain) return false;
    const user = await User.find(userId);
    return Boolean(user) && (await verifyPassword(plain, user!.password));
}

function sendFailure(res: TylixResponse, sent: Extract<SendResult, { ok: false }>) {
    const status = sent.reason === "cooldown" || sent.reason === "limit" ? 429 : sent.reason === "not_configured" ? 503 : 502;
    return res.status(status).json({ error: sent.message });
}

export class SmsTwoFactorController {
    async setup(req: TylixRequest, res: TylixResponse) {
        const userId = userIdOf(req);
        const key = gateKey(userId);
        const body = bodyOf(req);

        if (!sendGuard(req, res)) return;
        if (!passwordGate.check(key, res)) return;

        const phone = SmsTwoFactorService.normalizePhone(body.phone);

        const errors: Record<string, string[]> = {};
        if (!phone) errors.phone = ["Enter a valid mobile number, like 0712345678 or +254712345678."];

        if (await passwordOk(userId, body.password)) {
            passwordGate.clear(key);
        } else {
            passwordGate.fail(key);
            errors.password = ["That password is incorrect."];
        }

        if (Object.keys(errors).length > 0) return res.status(422).json({ errors });

        const existing = await SmsTwoFactorService.find(userId);
        if (existing?.confirmed_at) {
            return res.status(409).json({ error: "Text-message codes are already on. Turn them off first to use a different number." });
        }

        const row = await SmsTwoFactorService.prepare(userId, phone as string);
        const sent = await SmsTwoFactorService.sendCode(row);
        if (!sent.ok) return sendFailure(res, sent);

        return res.json({ ok: true, phone_hint: SmsTwoFactorService.maskPhone(row.phone) });
    }

    async confirm(req: TylixRequest, res: TylixResponse) {
        const userId = userIdOf(req);
        const key = gateKey(userId);

        if (!codeGate.check(key, res)) return;

        const row = await SmsTwoFactorService.find(userId);
        if (!row || row.confirmed_at || !row.phone) {
            return res.status(400).json({ error: "Start the text-message setup first." });
        }

        const ok = await SmsTwoFactorService.verifyCode(row, String(bodyOf(req).code ?? ""));
        if (!ok) {
            codeGate.fail(key);
            return res.status(422).json({ errors: { code: ["That code is incorrect or has expired."] } });
        }

        codeGate.clear(key);
        await SmsTwoFactorService.markConfirmed(row.id);
        return res.json({ ok: true, phone_hint: SmsTwoFactorService.maskPhone(row.phone) });
    }

    async sendCode(req: TylixRequest, res: TylixResponse) {
        if (!sendGuard(req, res)) return;

        const row = await SmsTwoFactorService.find(userIdOf(req));
        if (!row || !row.phone) {
            return res.status(400).json({ error: "Text-message codes aren't set up." });
        }

        const sent = await SmsTwoFactorService.sendCode(row);
        if (!sent.ok) return sendFailure(res, sent);

        return res.json({ ok: true, phone_hint: SmsTwoFactorService.maskPhone(row.phone) });
    }

    async disable(req: TylixRequest, res: TylixResponse) {
        const userId = userIdOf(req);
        const key = gateKey(userId);
        const body = bodyOf(req);

        if (!passwordGate.check(key, res)) return;
        if (!codeGate.check(key, res)) return;

        const row = await SmsTwoFactorService.find(userId);
        if (!row?.confirmed_at) {
            return res.status(400).json({ error: "Text-message codes aren't turned on." });
        }

        // Password first. While it is wrong the code is never checked, so this
        // endpoint can't be used to test codes.
        if (!(await passwordOk(userId, body.password))) {
            passwordGate.fail(key);
            return res.status(422).json({ errors: { password: ["That password is incorrect."] } });
        }
        passwordGate.clear(key);

        // Any enabled method works here: an authenticator code, a recovery code or a texted code.
        const check = await TwoFactorService.loginChallenge(userId, body.code);
        if (check.result !== "ok") {
            if (check.result === "invalid") codeGate.fail(key);
            return res.status(422).json({ errors: { code: ["That code is incorrect or has expired."] } });
        }
        codeGate.clear(key);

        await SmsTwoFactorService.reset(row.id);
        return res.json({ ok: true });
    }
}