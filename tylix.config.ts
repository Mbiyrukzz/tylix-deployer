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
