/**
 * HTML page shown after the user clicks the link in the verification email.
 * Self-contained (inline CSS, inline SVG) so it can be sent straight from an
 * API route. Follows the visitor's light/dark setting.
 */

export type VerifyState = "success" | "already" | "invalid";

const APP_NAME = "Tylix Deployer"; // change to your product name
const LOGIN_URL = (process.env.APP_URL ?? "") + "/login";

const escapeHtml = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const INFO =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>';
const CLOCK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

const CONTENT: Record<VerifyState, { tone: string; icon: string; title: string; text: string; button: string; hint: string }> = {
    success: {
        tone: "ok",
        icon: CHECK,
        title: "Email verified",
        text: "Thanks for confirming your address. Your account is ready to use.",
        button: "Continue to sign in",
        hint: "You can close this tab if you've already signed in elsewhere.",
    },
    already: {
        tone: "info",
        icon: INFO,
        title: "Already verified",
        text: "This email address was confirmed earlier. There's nothing more to do.",
        button: "Go to sign in",
        hint: "",
    },
    invalid: {
        tone: "warn",
        icon: CLOCK,
        title: "This link has expired",
        text: "The verification link is invalid or has already been replaced. Sign in and we'll send you a fresh one.",
        button: "Go to sign in",
        hint: "Links stop working once a newer one is sent.",
    },
};

export function renderVerifyPage(state: VerifyState, email?: string): string {
    const c = CONTENT[state];
    const who = email ? `<p class="email">${escapeHtml(email)}</p>` : "";
    const hint = c.hint ? `<p class="hint">${escapeHtml(c.hint)}</p>` : "";

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(c.title)} · ${escapeHtml(APP_NAME)}</title>
<style>
  :root {
    --bg: #f1f5f9; --card: #ffffff; --border: #e2e8f0;
    --text: #0f172a; --muted: #64748b; --faint: #94a3b8;
    --ok: #059669; --ok-bg: rgba(16,185,129,.12);
    --info: #0284c7; --info-bg: rgba(14,165,233,.12);
    --warn: #d97706; --warn-bg: rgba(245,158,11,.14);
    --btn: #10b981; --btn-hover: #34d399; --btn-text: #ffffff;
    --glow: rgba(16,185,129,.18); --shadow: 0 10px 40px rgba(15,23,42,.08);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #020617; --card: #0f172a; --border: #1e293b;
      --text: #f1f5f9; --muted: #94a3b8; --faint: #64748b;
      --ok: #34d399; --info: #38bdf8; --warn: #fbbf24;
      --btn-text: #020617; --glow: rgba(16,185,129,.14); --shadow: none;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: 24px; gap: 28px; color: var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background:
      var(--bg);
    -webkit-font-smoothing: antialiased;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; letter-spacing: -.01em; }
  .brand i {
    width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center;
    background: var(--btn); color: var(--btn-text); font-style: normal; font-weight: 800; font-size: 14px;
  }
  .card {
    width: 100%; max-width: 440px; text-align: center; padding: 40px 32px 32px;
    background: var(--card); border: 1px solid var(--border); border-radius: 24px; box-shadow: var(--shadow);
    animation: rise .45s cubic-bezier(.2,.8,.2,1) both;
  }
  .icon {
    width: 72px; height: 72px; margin: 0 auto 24px; border-radius: 9999px; display: grid; place-items: center;
    animation: pop .5s .1s cubic-bezier(.2,1.4,.4,1) both;
  }
  .icon svg { width: 34px; height: 34px; }
  .ok   .icon { background: var(--ok-bg);   color: var(--ok); }
  .info .icon { background: var(--info-bg); color: var(--info); }
  .warn .icon { background: var(--warn-bg); color: var(--warn); }
  h1 { margin: 0 0 10px; font-size: 26px; line-height: 1.2; letter-spacing: -.02em; }
  .email {
    display: inline-block; margin: 0 0 14px; padding: 4px 12px; border-radius: 9999px;
    background: var(--ok-bg); color: var(--ok); font: 500 13px ui-monospace, SFMono-Regular, Menlo, monospace;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  p.text { margin: 0 0 28px; color: var(--muted); font-size: 15px; line-height: 1.6; }
  a.btn {
    display: inline-flex; align-items: center; justify-content: center; width: 100%;
    padding: 13px 20px; border-radius: 9999px; background: var(--btn); color: var(--btn-text);
    font-weight: 600; font-size: 15px; text-decoration: none; transition: background .15s, transform .15s;
  }
  a.btn:hover { background: var(--btn-hover); }
  a.btn:active { transform: scale(.99); }
  a.btn:focus-visible { outline: 3px solid var(--glow); outline-offset: 2px; }
  .hint { margin: 18px 0 0; color: var(--faint); font-size: 12.5px; }
  footer { color: var(--faint); font-size: 12px; }
  @keyframes rise { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
  @keyframes pop  { from { opacity: 0; transform: scale(.6); }       to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .card, .icon { animation: none; } }
</style>
</head>
<body>
  <div class="brand"><i>T</i><span>${escapeHtml(APP_NAME)}</span></div>

  <main class="card ${c.tone}" role="main">
    <div class="icon" aria-hidden="true">${c.icon}</div>
    <h1>${escapeHtml(c.title)}</h1>
    ${who}
    <p class="text">${escapeHtml(c.text)}</p>
    <a class="btn" href="${escapeHtml(LOGIN_URL)}">${escapeHtml(c.button)}</a>
    ${hint}
  </main>

  <footer>&copy; ${new Date().getFullYear()} ${escapeHtml(APP_NAME)}</footer>
</body>
</html>`;
}