# Tylix Flux

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
- **Navigation**: see "App shell" below.

## App shell (Tylix Flux redesign, Nov 2026)

Every Tylix page is its own document, so a plain link used to rebuild the
sidebar and top bar on every click. `public/app-shell.js` now keeps them:

- **One shell per visit.** `app/pages/_layout.tyx` renders the sidebar
  (`components/Sidebar.tyx`), top bar (`Topbar.tyx`) and command palette
  (`CommandPalette.tyx`) once. Clicking between app pages (dashboard,
  servers, providers, registrars, source control, team, settings) fetches
  the next page, runs its script against a hidden staging area and moves
  only the page into `<main>`. The old page stays on screen (frozen) until
  the new one has data, then they swap with a short fade. URLs, titles,
  back/forward, scroll position and `window.location.href = ...` in page
  code all work as before.
- **Pages clean up after themselves.** Timers, sockets, EventSources and
  window/document listeners a page creates are released when you leave it.
  `__flux.stats()` in the console shows what the current page holds and
  what the last page released. Shell components register theirs with
  `__flux.on(...)` / `__flux.every(...)`, which are never released.
- **Falls back safely.** Terminals (`HARD_PATHS` in app-shell.js), public
  pages, links with `data-no-soft`, `target` or `download`, and anything
  unexpected (a failed fetch, a page that doesn't render in 20 s) are
  normal page loads. It runs under the default Tylix CSP (no eval).
- **Faster clicks.** Hovering or touching a link prefetches the page.
- **Resilient requests.** GET/HEAD `/api` calls retry twice on network
  errors and 502/503/504; any 401 refreshes the session once. Offline,
  back-online and "session ended" notices appear as toasts, and signing in
  again returns you to the page you were on (`/login?next=`).
- **Keyboard.** Cmd/Ctrl+K or `/` opens the palette (pages, servers, sites,
  cloud accounts, registrars, actions). `g` then `d s p r c t ,` jumps to a
  section. `[` collapses the sidebar.
- **Overview data.** `GET /api/insights/deployments?range=daily|weekly|monthly`
  (`app/routes/insights.ts`) feeds the deployments chart and the latest
  deployments list, team-scoped.

Design tokens live in `tailwind.config.js` (one crimson accent, one neutral
scale that zinc/stone/slate/neutral/gray all point to) and the surface
variables in `app/tailwind-input.css`. Geist and Geist Mono are served from
`public/fonts` so they work offline and under a strict CSP. Technical
identifiers that servers already depend on (`tylix-deploy` cloud tags, the
AWS security group name, `/var/lib/tylix-deploy`, key comments) keep their
old names on purpose.
