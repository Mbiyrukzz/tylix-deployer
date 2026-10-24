/**
 * Service: StepUpService
 *
 * Re-checks a second factor before a sensitive action (creating, adding or
 * deleting a server).
 *
 *   - 2FA off (neither authenticator nor SMS): always passes
 *   - 2FA on, no code: answers 403 with two_factor_required and the methods
 *   - 2FA on, bad code: answers 422 with errors.code
 *   - accepts whatever login accepts: authenticator code, recovery code or
 *     texted code (loginChallenge does the checking)
 *
 * Call it right before the irreversible step, after every check that could
 * refuse the request anyway, so a code is never spent on a request that was
 * going to fail.
 *
 * `action` finishes the sentence "Enter a verification code to ...".
 */

import type { TylixRequest, TylixResponse } from "@tylix/core";
import { TwoFactorService } from "./TwoFactorService.js";
import { SmsTwoFactorService } from "./SmsTwoFactorService.js";

export class StepUpService {
    /** Returns true if the action may go ahead. Otherwise it has already answered. */
    static async require(
        req: TylixRequest,
        res: TylixResponse,
        code: unknown,
        action = "continue",
    ): Promise<boolean> {
        const userId = Number(req.user?.userId);

        const totpOn = await TwoFactorService.isEnabled(userId);
        const smsRow = await SmsTwoFactorService.find(userId);
        const smsOn = Boolean(smsRow?.confirmed_at);

        if (!totpOn && !smsOn) return true;

        const methods: string[] = [];
        if (totpOn) methods.push("totp");
        if (smsOn) methods.push("sms");

        const input = String(code ?? "").trim();

        if (!input) {
            res.status(403);
            res.json({
                error: `Enter a verification code to ${action}.`,
                two_factor_required: true,
                methods,
            });
            return false;
        }

        const outcome = await TwoFactorService.loginChallenge(userId, input);
        if (outcome.result === "ok") return true;

        res.status(422);
        res.json({ errors: { code: ["That code is wrong or has expired."] } });
        return false;
    }
}