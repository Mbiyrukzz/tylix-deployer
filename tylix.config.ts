export default {
  database: {
    driver: process.env.DATABASE_DRIVER || 'mysql',
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT) || 3306,
    user: process.env.DATABASE_USER || 'root',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'typloy',
  },
  auth: {
    secret: process.env.AUTH_SECRET,
    tokenExpiresInSeconds: 60 * 60 * 24 * 7,

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
};