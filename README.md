# tylix-deploy

A deployer for Tylix apps (and later Laravel, Next.js, and React), built with Tylix itself.

## Setup

```bash
cp .env.example .env     # fill in DATABASE_* and AUTH_SECRET
npm install
npx tylix migrate
npm run dev
```

## Workflow

- `main` is always deployable
- Solo project: commit small and often straight to `main`
- Conventional Commits (`feat:`, `fix:`, `chore:`)
- Tagged `v0.x.0` at the end of each roadmap phase

## Tylix 2 upgrade (Nov 2026)

After pulling: `npm install && npx tylix migrate` (adds `auth_sessions`,
`oauth_accounts` and `jobs.available_at`). Everyone signs in once more.

- **Auth**: rotating 30-day sessions with theft detection, 15-minute access
  tokens refreshed by `public/app-shell.js`, Settings → Password lists
  signed-in devices, optional Google/GitHub sign-in (`GOOGLE_*`, `GITHUB_*`).
  The process runs in UTC (`tylix.config.ts`) so MySQL dates read back right.
- **Permissions**: `app/permissions.ts`; roles come from team membership
  (owner / admin / member). `can("servers.manage")` in templates,
  `requirePermission(req, res, "...")` in routes. `npx tylix permission:show`.
- **PWA**: installable, offline page, update prompt (`pwa` in tylix.config).
- **Invoices**: PDF per invoice and Excel export on Settings → Invoices
  (owner only). Seller details from `INVOICE_*` in `.env`.
- **Navigation**: links prerender on hover, pages cross-fade, and the
  full-screen loader only shows on the first visit (`public/app-shell.js`,
  `app/head.html`).
