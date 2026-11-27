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

## Profile pictures, logos and source control (Nov 2026)

After pulling: `npx tylix migrate` (adds `user_avatars`, `users.avatar_hash`
and `sourceproviders.avatar_url` / `display_name`).

- **Profile pictures**: Settings → Account. The browser crops the image to a
  256×256 WebP before upload (`PUT /api/account/avatar`); it is stored in
  `user_avatars` and served at `/api/avatars/<user id>/<content hash>`
  (public, cached for good, a new upload gets a new URL). The sidebar, top
  bar and Team page show it; the page tells the shell through `flux:user`.
- **Loader**: `LoaderMark` / `PageLoader` are the same loader as Ashmif Hub
  (the Tylix mark lit stroke by stroke, `.tx-loader` in tailwind-input.css).
  The `--tx-*` colour tokens also theme the Tylix loading screen.
- **Logos**: `BrandLogo` shows a provider's logo from `public/logos` (or a
  letter). Provider and registrar sidebars load their connection and show
  its logo and name on every subpage.
- **Source control detail**: `/source-control/connection?id=` shows the
  GitHub / GitLab account behind a token (picture, profile, token scopes and
  expiry, rate limit), the sites deploying from it and, for admins, its
  repositories. Data: `GET /api/source-providers/:id/profile`.

## Passkeys, QR codes and dashboard (Nov 2026)

After pulling: `npx tylix migrate` (adds `user_passkeys`).

- **Passkeys**: Settings → Two-factor → Passkeys (needs the password to add
  one). The login page has "Sign in with a passkey". A passkey must verify
  the person (fingerprint, face or PIN), so it signs in without a password
  or code. WebAuthn checks are in `app/services/PasskeyService.ts` (no
  dependencies; ES256, EdDSA and RS256), routes in `app/routes/passkeys.ts`,
  browser side in `app/useApi/passkey.ts`. Passkeys are bound to one origin:
  `APP_URL` (or `PASSKEY_ORIGIN`) must be the address people use; localhost
  works over http, anything else needs https.
- **Authenticator QR code**: `POST /api/account/two-factor/setup` also
  returns `qr`, an SVG data URL made on the server (`app/services/QrSvg.ts`,
  the `@tylix/pdf` encoder), so the secret never goes to a QR service.
- **Source control**: repositories are paginated (10/20/50/100 per page)
  with All / Public / Private filters.
- **Overview**: a status row (servers, sites, deploys, domains) leads the
  page; problems moved from the top into a "Needs attention" card, and
  failed sites sort below healthy ones in "Recently active projects".
- **Settings → Members**: pictures, role counts, search, inline role
  changes, confirm-in-place for remove / revoke / leave, and what each role
  can do. Section sidebars share the main sidebar's look.
- **Cloud and domain providers**: both list pages show each connection with
  its provider's logo, a filter by provider, and a "Connect another account"
  gallery of every supported provider. `ProviderForm` / `RegistrarForm`
  take `start="<kind>" variant="tile"` for those tiles. New logos in
  `public/logos` (from Simple Icons): `aws`, `route53`, `spaceship`.
  Dynadot and Name.com have no Simple Icons logo, so they show a letter.

## Flux admin: users and "sign in as" (Nov 2026)

After pulling: `npx tylix migrate` (adds `admin_impersonations`) and set
`FLUX_ADMIN_EMAILS=you@example.com` in `.env`, then restart.

- **Who**: accounts whose verified email is in `FLUX_ADMIN_EMAILS`. It's
  env-only on purpose, so nothing in the app can grant it. They see
  **Flux admin → Users** (`/admin`) in the sidebar; everyone else gets 404s
  from `/api/admin/*`.
- **Sign in as**: needs the admin's own two-factor (a fresh code) and a
  written reason. It opens a new session for the user, tagged server-side
  with the admin's id (`auth_sessions.data.imp`, `imp` claim on the access
  token), and ends the admin's own session. Hard limit: 60 minutes
  (`IMPERSONATION_MINUTES`). A banner under the top bar shows it on every
  page; **Return to admin** (or Sign out in the menu) signs the admin back in.
- **Locked while signed in as someone** (403 `IMPERSONATION_BLOCKED`): the
  user's password, two-factor, passkeys and sessions, billing checkout and
  cancel, provider payments, leaving a team and accepting invites. Not
  allowed at all: signing in as another Flux admin, or nesting. The list is
  `BLOCKED` in `app/services/FluxAdmin.ts`, enforced by the global
  middleware in `app/routes/web.ts`.
- **Accountability**: step-up codes (deleting a server, ...) are checked
  against the admin's two-factor, not the user's. Server log entries
  written meanwhile carry `meta.impersonated_by`. Every session is a row in
  `admin_impersonations` (who, as whom, why, IP, start, end and how it
  ended), listed on the Admin page.
- An admin whose two-factor is texted codes only can start a session, but
  can't receive step-up texts from inside the user's account (texting
  would go to the user). Use an authenticator app.

## Importing a server (Vito and hand-built servers, Nov 2026)

After pulling: `npx tylix migrate` (adds `sites.origin`).

Add the server as usual (Servers → New server, SSH as root or a passwordless
sudo user), then Sites → **Import from server**
(`/servers/server-import?id=`). The scan is read-only; importing adopts what
you tick and reinstalls nothing. Code: `app/services/ServerImport.ts`, routes
`POST /api/servers/:id/import/scan` and `POST /api/servers/:id/import`.

- **Sites**: offered when the nginx root is `/home/<user>/<domain>[/<web dir>]`
  (Vito's layout), owned by that user. The nginx file is renamed to
  `sites-available/<domain>.conf` (same content, original in
  `/etc/nginx/tylix-backups`, rolled back if `nginx -t` fails); PHP sites get
  Flux's pool `pool.d/<user>.conf` next to the existing ones (reload, no
  restart). The `.env` is stored in Flux, so later deploys write it back. An
  SSH git remote can be switched to HTTPS so deploys use the team's GitHub /
  GitLab connection instead of the old deploy key.
- **Shared users**: imported sites may share a user (Vito runs everything as
  `vito`). They are stored with `origin = "import"`, and deleting one removes
  only its nginx file, certificate and `/home/<user>/<domain>`, never the
  user. Per-user plugins (queue, Octane, Reverb, scheduler, rate limit,
  resource limits) are refused while the user is shared, deploys never write
  or restart PHP-FPM pools for them, and a Node site needs a user of its own
  (its service is `app-<user>`).
- **Databases**: records only. Owners are the `@localhost` users with grants;
  passwords are filled in from a site's `.env` / `wp-config.php` when the
  user name matches, otherwise left unknown (reset it on the Databases page).
- **Workers / cron**: rewritten as `tylix-worker-<id>` / `/etc/cron.d/tylix-cron-<id>`
  (new one first, then the old program or crontab line is removed; old
  Supervisor files go to `/etc/supervisor/tylix-backups`). Their file
  builders are shared with the Workers and Cron pages
  (`app/services/WorkerFiles.ts`, `CronFiles.ts`).
- **Reconnecting a repository**: Site → Settings → Repository (also linked
  from the Deploy page when a site has none). `PUT /api/sites/:id/source`
  (`app/services/SiteSource.ts`) points the checkout's origin at the repo over
  HTTPS, fetches the branch with the team's token (proving access) and
  switches branch only when nothing would be lost. A folder with no checkout,
  or code that isn't on that branch, needs an explicit "match the folder"
  (`git checkout -f -B`; untracked files such as `.env` and uploads stay).
  Any failure restores the old origin. Needs a 2FA code when two-factor is
  on; `source_control_id: 0` disconnects without touching the server.
- **Moving off Vito**: import, deploy each site once from Flux, then shut the
  Vito panel down. Don't delete the server or its sites inside Vito: that can
  remove files, deploy keys or (for provider servers) the VPS itself.

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
