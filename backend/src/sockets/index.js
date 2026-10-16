const { syncDriverDistrictRoom } = require('./roomSync');
const { Server } = require('socket.io');
const env = require('../config/env');
const logger = require('../config/logger');
const { verifyAccessToken } = require('../utils/jwt');
const { setIO } = require('../lib/socket');
const { validateCredentialSession } = require('../modules/auth/credential-session');
const prisma = require('../lib/prisma');
const rooms = require('./rooms');
const adminService = require('../modules/admin/admin.service');
const driverService = require('../modules/driver/driver.service');

// Socket.IO auth middleware: expects the JWT access token at
// `socket.handshake.auth.token` (preferred, e.g. `io(url, { auth: { token } })`).
async function socketAuthMiddleware(socket, next) {
  const token =
    socket.handshake.auth && socket.handshake.auth.token
      ? socket.handshake.auth.token
      : socket.handshake.query && socket.handshake.query.token;

  if (!token) return next(new Error('unauthorized'));

  try {
    const payload = verifyAccessToken(token);
    await validateCredentialSession(payload);
    socket.data.credentials = payload;
    socket.data.user = {
      id: payload.sub,
      role: payload.role,
      driverId: payload.driverId,
      adminId: payload.adminId
    };
    next();
  } catch (err) {
    next(new Error('unauthorized'));
  }
}

async function handleDriverConnection(socket) {
  const { driverId } = socket.data.user;

  const driver = await prisma.driver.findUnique({ where: { id: driverId }, include: { user: { include: { balance: true } } } });
  if (!driver || driver.status !== 'APPROVED') {
    socket.emit('error', { message: 'Доступ запрещён' });
    socket.disconnect(true);
    return;
  }

  socket.join(rooms.driver(driverId));
  socket.join(rooms.drivers());
  await validateCredentialSession(socket.data.credentials);
  socket.use(async (_packet, next) => {
    try { await validateCredentialSession(socket.data.credentials); next(); }
    catch { socket.disconnect(true); }
  });
  await syncDriverDistrictRoom(driverId);

  // Symmetric with the admin side's socket.on('admin:message', ...) below -
  // Чат Админ ↔ водитель works the same way from either end.
  socket.on('driver:message', async (payload, ack) => {
    try {
      const body = payload && payload.body;
      const message = await driverService.sendMessage(driver, body);
      if (typeof ack === 'function') ack({ ok: true, message });
    } catch (err) {
      logger.warn({ err }, 'driver:message via socket failed');
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });
}

function handleAdminConnection(socket) {
  socket.join(rooms.admins());
  socket.join(rooms.districtsOverview());

  // Convenience: let a connected admin dashboard push a message over the
  // socket directly, in addition to POST /admin/messages.
  socket.on('admin:message', async (payload, ack) => {
    try {
      const result = await adminService.sendMessage(payload || {}, socket.data.user.id);
      if (typeof ack === 'function') ack({ ok: true, result });
    } catch (err) {
      logger.warn({ err }, 'admin:message via socket failed');
      if (typeof ack === 'function') ack({ ok: false, error: err.message });
    }
  });
}

function initSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.corsOrigin, credentials: true }
  });

  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    const { role, id: userId } = socket.data.user;
    logger.debug({ userId, role, socketId: socket.id }, 'Socket connected');

    if (role === 'DRIVER') {
      handleDriverConnection(socket).catch((err) => {
        logger.error({ err }, 'Error handling driver socket connection');
        socket.disconnect(true);
      });
    } else if (role === 'ADMIN') {
      handleAdminConnection(socket);
    } else {
      // No client-side realtime features implemented yet (see migration plan).
      socket.disconnect(true);
    }
  });

  const offerSweep = setInterval(() => require('../modules/orders/orders.service').expirePrivateOffers().catch(err => logger.warn({ err }, 'Private offer expiry failed')), 1000);
  offerSweep.unref();
  io.engine.on('close', () => clearInterval(offerSweep));
  setIO(io);
  return io;
}

module.exports = initSockets;
