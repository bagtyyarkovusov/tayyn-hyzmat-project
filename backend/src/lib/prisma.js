const { PrismaClient } = require('@prisma/client');
const env = require('../config/env');

// A single shared PrismaClient instance for the whole process.
// Re-creating clients per-request would exhaust DB connections.
const prisma = new PrismaClient({
  log: env.isProduction ? ['error', 'warn'] : ['error', 'warn']
});

module.exports = prisma;
