const http = require('http');
const env = require('./config/env');
const logger = require('./config/logger');
const app = require('./app');
const prisma = require('./lib/prisma');
const initSockets = require('./sockets');

const { clearExpiredAddressCache } = require('./modules/geo/driver-address');
const purgeAddresses = () => clearExpiredAddressCache().catch(() => logger.warn('Expired address cache cleanup failed'));
void purgeAddresses();
const addressCleanup = setInterval(purgeAddresses, 60_000);
addressCleanup.unref();

const httpServer = http.createServer(app);
initSockets(httpServer);

const server = httpServer.listen(env.port, () => {
  logger.info(`OpenRide backend listening on port ${env.port} [${env.nodeEnv}]`);
});

async function shutdown(signal) {
  clearInterval(addressCleanup);
  logger.info(`${signal} received, shutting down gracefully...`);
  server.close(async () => {
    await prisma.$disconnect();
    logger.info('Shutdown complete');
    process.exit(0);
  });
  // Force-exit if graceful shutdown hangs (e.g. a long-lived connection won't close).
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
