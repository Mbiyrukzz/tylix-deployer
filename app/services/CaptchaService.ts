/**
 * Server-side CAPTCHA verification for reCAPTCHA or Cloudflare Turnstile
 * (both use the same request/response shape).
 *
 * Disabled when CAPTCHA_SECRET is empty (local dev). When it IS set, any
 * failure to verify, including the provider being unreachable, counts as a
 * failed check, so an outage can't be used to skip it.
 */

const VERIFY_URLS: Record<string, string> = {
    recaptcha: "https://www.google.com/recaptcha/api/siteverify",
    turnstile: "https://challenges.cloudflare.com/turnstile/v0/siteverify",
};

const TIMEOUT_MS = 5000;

export class CaptchaService {
    static enabled(): boolean {
        return Boolean(process.env.CAPTCHA_SECRET);
    }

    static async verify(token: unknown, ip: string): Promise<boolean> {
        if (!this.enabled()) return true;
        if (typeof token !== "string" || token.length === 0 || token.length > 4096) return false;

        const provider = (process.env.CAPTCHA_PROVIDER ?? "recaptcha").toLowerCase();
        const url = VERIFY_URLS[provider];
        if (!url) {
            console.error(`[captcha] unknown CAPTCHA_PROVIDER "${provider}"`);
            return false;
        }

        const body = new URLSearchParams({
            secret: process.env.CAPTCHA_SECRET as string,
            response: token,
        });
        if (ip && ip !== "unknown") body.set("remoteip", ip);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const response = await fetch(url, { method: "POST", body, signal: controller.signal });
            if (!response.ok) return false;
            const data = (await response.json()) as { success?: boolean };
            return data.success === true;
        } catch (error) {
            console.error("[captcha] verification request failed:", error);
            return false;
        } finally {
            clearTimeout(timer);
        }
    }
}