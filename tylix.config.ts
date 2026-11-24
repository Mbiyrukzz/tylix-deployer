import { defineConfig } from '@tylix/shared';

// Run in UTC. The ORM writes every timestamp as a UTC ISO string, and the
// MySQL driver reads DATETIME columns back in the process's local zone. On
// a machine that isn't on UTC every date came back hours off, and refresh
// token rotation (which compares rotated_at with now) treated two tabs
// refreshing together as token theft and signed people out. Every tylix
// command (dev, start, migrate, queue:work) loads this file first.
process.env.TZ = 'UTC';

export default defineConfig({
  database: {
    driver: (process.env.DATABASE_DRIVER || 'mysql') as 'mysql',
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT) || 3306,
    user: process.env.DATABASE_USER || 'root',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'typloy',
  },

  // Installable app and offline page (@tylix/pwa). Tylix serves the manifest
  // and service worker; the icons and offline.html are in public/. Pages are
  // never cached (they hold a signed-in user's servers and secrets), so
  // offline visitors get public/offline.html. The shortcuts open straight
  // from the home-screen icon.
  pwa: {
    name: 'Tylix Flux',
    shortName: 'Flux',
    description: 'Provision servers, deploy sites and manage domains from anywhere.',
    startUrl: '/dashboard',
    themeColor: '#09090a',
    backgroundColor: '#09090a',
    shortcuts: [
      { name: 'Servers', url: '/servers' },
      { name: 'New server', url: '/servers/create' },
      { name: 'Billing', url: '/settings/billing' },
    ],
    // The shell scripts aren't fingerprinted, so the worker's default for
    // .js (stale-while-revalidate) served the previous deploy's copy once
    // after every release. An old app-shell.js doesn't know newer app
    // sections (/admin): the page loaded without the sidebar. Always fetch
    // them fresh; the cached copy is only for offline.
    runtimeCaching: [
      { match: '^/(app-shell|auth-ui)\\.js$', strategy: 'network-first' },
    ],
  },

  auth: {
    secret: process.env.AUTH_SECRET,
    // Lifetime of an access token, in seconds. Tylix 2 caps it at an hour:
    // the rotating 30-day refresh session keeps people signed in (and
    // public/app-shell.js refreshes it in the browser), while logout, "sign
    // out everywhere" and password resets apply at once.
    tokenExpiresInSeconds: 15 * 60,

    // Adds teamId and teamRole to req.user. The logic lives in
    // app/services/AuthHydrate.ts. It is imported lazily so the models
    // aren't loaded while the config is being read (for example by
    // `tylix migrate`).
    hydrate: (user: { userId?: unknown }) =>
      import('./app/services/AuthHydrate.js')
        .then((m) => m.hydrateAuth(user))
        .catch((error) => {
          console.error('[auth] could not load AuthHydrate, continuing without team:', error)
          return {}
        }),
  },

  mail: {
    driver: process.env.MAIL_DRIVER || 'log',
    from: process.env.MAIL_FROM || 'noreply@example.com',
    host: process.env.MAIL_HOST || '',
    port: Number(process.env.MAIL_PORT) || 587,
    user: process.env.MAIL_USER || '',
    password: process.env.MAIL_PASSWORD || '',
    secure: process.env.MAIL_SECURE === 'true',
  },

  logging: {
    // LOG_CHANNEL / LOG_STACK pick the channels (default console + daily
    // files in storage/logs). Deploys and provisioning get their own files
    // so one noisy server doesn't bury everything else.
    channels: {
      deploys: { driver: 'daily', path: 'storage/logs/deploys.log', level: 'info' },
      provisioning: { driver: 'daily', path: 'storage/logs/provisioning.log', level: 'info' },
    },
  },
});
