// Loads and validates environment variables once, at process start.
// Fails fast (before the HTTP server even opens a port) if something
// required for a safe production run is missing - this is deliberately
// stricter than "just let it crash later on first use".
require('dotenv').config();

const REQUIRED = ['DATABASE_URL', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'];

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length) {
  // eslint-disable-next-line no-console
  console.error(`[env] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 4000,
  corsOrigin: (process.env.CORS_ORIGIN || 'http://localhost:8080')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  databaseUrl: process.env.DATABASE_URL,

  jwtAccessSecret: process.env.JWT_ACCESS_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',

  seedAdminPhone: process.env.SEED_ADMIN_PHONE || '+10000000000',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!',
  seedAdminName: process.env.SEED_ADMIN_NAME || 'Super Admin',

  isProduction: process.env.NODE_ENV === 'production'
};

if (env.isProduction) {
  const insecureDefaults = ['change-me-access-secret', 'change-me-refresh-secret'];
  if (insecureDefaults.includes(env.jwtAccessSecret) || insecureDefaults.includes(env.jwtRefreshSecret)) {
    // eslint-disable-next-line no-console
    console.error('[env] Refusing to start in production with default JWT secrets. Set real secrets.');
    process.exit(1);
  }
}

module.exports = env;
