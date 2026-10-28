/**
 * Typed bridge for the Login / Register pages.
 *
 *  - CAPTCHA calls go to /auth-ui.js (loaded through app/head.html). If that
 *    script isn't there, they quietly do nothing and captchaEnabled() is false.
 *  - passwordChecks() runs here directly, so the register form's rule list and
 *    strength meter never depend on another script.
 *
 * Keep the length limits in step with app/validators/PasswordPolicy.ts.
 */

interface PasswordChecks {
    length: boolean;
    letter: boolean;
    number: boolean;
    symbol: boolean;
    ok: boolean;
    label: string;
    pct: number;
    color: string;
}

const AUTH_UI_MIN_PASSWORD_LENGTH = 10;
const AUTH_UI_MAX_PASSWORD_LENGTH = 128;

function authUiScript(): any {
    return (window as any).TylixAuthUi;
}

export const authUi = {
    captchaEnabled(): boolean {
        const ui = authUiScript();
        return Boolean(ui && ui.captchaEnabled());
    },

    mountCaptcha(containerId: string, onToken: (token: string) => void, onExpire: () => void): void {
        const ui = authUiScript();
        if (ui) ui.mountCaptcha(containerId, onToken, onExpire);
    },

    resetCaptcha(containerId: string): void {
        const ui = authUiScript();
        if (ui) ui.resetCaptcha(containerId);
    },

    unmountCaptcha(containerId: string): void {
        const ui = authUiScript();
        if (ui) ui.unmountCaptcha(containerId);
    },

    passwordChecks(password: string): PasswordChecks {
        const pw = String(password || "");
        const length = pw.length >= AUTH_UI_MIN_PASSWORD_LENGTH && pw.length <= AUTH_UI_MAX_PASSWORD_LENGTH;
        const letter = /\p{L}/u.test(pw);
        const number = /\d/.test(pw);
        const symbol = /[^\p{L}\d\s]/u.test(pw);
        const ok = length && letter && number && symbol;
        const met = (length ? 1 : 0) + (letter ? 1 : 0) + (number ? 1 : 0) + (symbol ? 1 : 0);

        let label = "";
        let pct = 0;
        let color = "#f43f5e";

        if (pw.length === 0) {
            label = "";
        } else if (!ok) {
            label = "Too weak";
            pct = 10 + met * 10;
        } else if (pw.length >= 18) {
            label = "Very strong";
            pct = 100;
            color = "#059669";
        } else if (pw.length >= 14) {
            label = "Strong";
            pct = 80;
            color = "#10b981";
        } else {
            label = "Okay";
            pct = 55;
            color = "#f59e0b";
        }

        return { length, letter, number, symbol, ok, label, pct, color };
    },
};