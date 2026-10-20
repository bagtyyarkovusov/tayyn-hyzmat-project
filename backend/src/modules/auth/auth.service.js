const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { hashPassword, comparePassword } = require('../../utils/password');
const {
  signAccessToken,
  generateRefreshToken,
  hashRefreshToken,
  parseDurationToMs
} = require('../../utils/jwt');
const env = require('../../config/env');
const { getIO } = require('../../lib/socket');
const rooms = require('../../sockets/rooms');
const logger = require('../../config/logger');

// How long a just-rotated refresh token keeps working - see refresh().
const ROTATION_GRACE_MS = 60 * 1000;

function sanitizeUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return { ...rest, ...(rest.driver ? { driver: require('../driver/public-profile').publicDriverProfile(rest.driver) } : {}) };
}

// Registers a new DRIVER account. Client/admin creation are intentionally
// not exposed on this public endpoint - admins are provisioned via seed/an
// internal process, and there is no client-facing flow yet (see migration
// plan). The driver starts in Driver.status = PENDING and cannot log in
// until an admin approves them. No session or device row is created here;
// deviceId/deviceLabel are accepted for older clients but ignored.
async function registerDriver({ phone, fullName, password }) {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    throw ApiError.conflict('Этот номер уже зарегистрирован. Войдите или обратитесь к диспетчеру.');
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        role: 'DRIVER',
        phone,
        fullName,
        passwordHash,
        driver: { create: { status: 'PENDING' } },
        balance: { create: { amount: 0, currency: 'TMT' } }
      },
      include: { driver: true, balance: true }
    });
    return created;
  });

  // Registration is already committed. Delivery failure must not turn it into
  // a retryable HTTP failure, and only admins need this invalidation signal.
  try {
    getIO().to(rooms.admins()).emit('driver:registered', { driverId: user.driver.id });
  } catch (err) {
    logger.warn({ err }, 'Failed to broadcast driver registration');
  }

  return {
    user: sanitizeUser(user),
    message: 'Регистрация прошла успешно. Ваш аккаунт ожидает подтверждения администратора.'
  };
}

async function issueTokenPair(user, db = prisma, deviceId, deviceVersion) {
  const payload = {
    sub: user.id,
    deviceId,
    deviceVersion,
    credentialVersion: user.credentialVersion,
    role: user.role,
    driverId: user.driver ? user.driver.id : undefined,
    adminId: user.admin ? user.admin.id : undefined
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = generateRefreshToken();

  await db.refreshToken.create({
    data: {
      userId: user.id,
      deviceId,
      deviceVersion,
      credentialVersion: user.credentialVersion,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + parseDurationToMs(env.jwtRefreshExpiresIn))
    }
  });

  return { accessToken, refreshToken };
}

// Explicit revocation advances the persisted generation: access tokens, rotated
// refresh tokens and native leases from that generation all lose authority.
async function revokeSessionGeneration(tx, userId) {
  await tx.user.update({ where: { id: userId }, data: { credentialVersion: { increment: 1 } } });
  await tx.refreshToken.updateMany({ where: { userId }, data: { revokedAt: new Date(0) } });
  await tx.notificationInstallation.updateMany({ where: { driver: { userId } }, data: { secretHash: null, token: null, coordinatorEnabled: false } });
  await tx.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE driver_id IN (SELECT id FROM drivers WHERE user_id = ${userId}) AND revoked_at IS NULL`;
  await tx.driver.updateMany({ where: { userId }, data: { isOnline: false, shiftDeviceId: null } });
}
async function publishSessionRevocation(userId) {
  try { await require('../native-shift/native-shift.service').publishUserShiftState(userId); }
  catch (err) { logger.warn({ err }, 'Failed to publish revoked shift state'); }
  // Committed revocation must still disconnect obsolete sockets if publication
  // fails; a concurrent new login's current-generation socket stays connected.
  try {
    const io = getIO();
    const current = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    for (const socket of await io.in(rooms.user(userId)).fetchSockets()) {
      if ((socket.data.credentials?.credentialVersion ?? 0) !== current.credentialVersion) {
        socket.emit('session:revoked', { message: 'Сессия завершена. Войдите снова.' });
        socket.disconnect(true);
      }
    }
  } catch (err) { logger.warn({ err }, 'Failed to disconnect revoked session sockets'); }
}
async function revokeAllRefreshTokens(userId, expectedVersion) {
  const revoked = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    if (expectedVersion !== undefined && user.credentialVersion !== expectedVersion) return false;
    await revokeSessionGeneration(tx, userId);
    return true;
  });
  if (revoked) await publishSessionRevocation(userId);
}

async function login({ phone, password, deviceId, deviceLabel }) {
  const observed = await prisma.user.findUnique({ where: { phone } });
  if (!observed || !(await comparePassword(password, observed.passwordHash))) {
    throw ApiError.unauthorized('Неверный номер телефона или пароль');
  }
  const result = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${observed.id} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: observed.id }, include: { driver: true, admin: true } });
    // Password work stays outside the lock. A reset/block that
    // wins meanwhile must not authorize the old password in a new generation.
    if (user.credentialVersion !== observed.credentialVersion || user.passwordHash !== observed.passwordHash) {
      throw ApiError.unauthorized('Данные входа изменены. Войдите снова');
    }
    if (user.status === 'BLOCKED') throw ApiError.forbidden('Ваш аккаунт заблокирован');
    let installation;
    if (user.role === 'DRIVER') {
      if (!user.driver) throw ApiError.notFound('Профиль водителя не найден');
      if (user.driver.status !== 'APPROVED') throw ApiError.forbidden(
        user.driver.status === 'PENDING' ? 'Ваш аккаунт ожидает подтверждения' : 'Ваш аккаунт заблокирован',
        { status: user.driver.status }
      );
      if (!deviceId) throw ApiError.badRequest('Для входа водителя требуется идентификатор устройства');
      installation = await tx.driverDevice.upsert({
        where: { driverId_deviceId: { driverId: user.driver.id, deviceId } },
        update: { lastLoginAt: new Date(), ...(deviceLabel ? { label: deviceLabel } : {}) },
        create: { driverId: user.driver.id, deviceId, label: deviceLabel || null }
      });
    }
    const pair = await issueTokenPair(user, tx, installation?.deviceId, installation?.sessionVersion);
    await tx.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return { ...pair, user: sanitizeUser(user) };
  });
  return result;
}

async function refresh(refreshToken) {
  const tokenHash = hashRefreshToken(refreshToken);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  if (!stored || stored.expiresAt < new Date()) {
    throw ApiError.unauthorized('Недействительный refresh-токен');
  }
  // A revoked token is normally a replay and must be refused - EXCEPT right
  // after this same token was legitimately rotated. The driver app can have
  // several requests in flight (a location POST every 5s, balance, current
  // order), so when the access token expires they can all 401 together and
  // race to refresh with the same stored token; the loser used to be logged
  // out with "Сессия истекла". The client now de-duplicates those
  // (services/apiClient.js#refreshOnce), and this window is the belt to that
  // braces: a token revoked seconds ago still works, one revoked long ago
  // (a real stolen-token replay) still doesn't.
  if (stored.revokedAt && Date.now() - stored.revokedAt.getTime() > ROTATION_GRACE_MS) {
    throw ApiError.unauthorized('Недействительный refresh-токен');
  }

  const user = await prisma.user.findUnique({
    where: { id: stored.userId },
    include: { driver: true, admin: true }
  });
  if (!user || user.status === 'BLOCKED' || user.credentialVersion !== stored.credentialVersion) {
    throw ApiError.unauthorized('Недействительный refresh-токен');
  }
  if (user.role === 'DRIVER' && user.driver && user.driver.status !== 'APPROVED') {
    throw ApiError.forbidden('Доступ запрещён', { status: user.driver.status });
  }

  if (user.role === 'DRIVER') {
    const device = stored.deviceId && await prisma.driverDevice.findUnique({ where: { driverId_deviceId: { driverId: user.driver.id, deviceId: stored.deviceId } } });
    if (!device || device.sessionVersion !== stored.deviceVersion) throw ApiError.unauthorized();
  }
  // Rotate: revoke the used token and issue a brand new pair. This limits
  // the blast radius if a refresh token is ever stolen/replayed. Already-
  // revoked-but-within-grace tokens keep their original revokedAt, so the
  // window can't be extended indefinitely by hammering the same token.
  if (!stored.revokedAt) {
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  }
  const pair = await issueTokenPair(user, prisma, stored.deviceId ?? undefined, stored.deviceVersion ?? undefined);

  return { ...pair, user: sanitizeUser(user) };
}

async function logout(refreshToken) {
  const session = await prisma.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(refreshToken) }, include: { user: true } });
  if (!session || session.expiresAt <= new Date() || session.credentialVersion !== session.user.credentialVersion ||
      (session.revokedAt && Date.now() - session.revokedAt.getTime() > ROTATION_GRACE_MS)) return;
  if (session.user.role !== 'DRIVER') return revokeAllRefreshTokens(session.userId, session.credentialVersion);
  const changed = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${session.userId} FOR UPDATE`;
    const driver = await tx.driver.findUnique({ where: { userId: session.userId }, include: { user: true } });
    if (!driver || driver.user.credentialVersion !== session.credentialVersion || !session.deviceId) return false;
    const device = await tx.driverDevice.findUnique({ where: { driverId_deviceId: { driverId: driver.id, deviceId: session.deviceId } } });
    if (!device || device.sessionVersion !== session.deviceVersion) return false;
    await tx.driverDevice.update({ where: { id: device.id }, data: { sessionVersion: { increment: 1 } } });
    await tx.refreshToken.updateMany({ where: { userId: session.userId, deviceId: session.deviceId }, data: { revokedAt: new Date(0) } });
    if (driver.isOnline && driver.shiftDeviceId === session.deviceId) {
      await tx.driver.update({ where: { id: driver.id }, data: { isOnline: false, shiftDeviceId: null } });
      await tx.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE driver_id = ${driver.id} AND revoked_at IS NULL`;
      return true;
    }
    return false;
  });
  if (changed) {
    try { await require('../native-shift/native-shift.service').publishUserShiftState(session.userId); }
    catch (err) { logger.warn({ err }, 'Failed to publish logged-out device shift state'); }
  }
  try {
    for (const socket of await getIO().in(rooms.user(session.userId)).fetchSockets()) {
      try { await require('./credential-session').validateCredentialSession(socket.data.credentials); }
      catch { socket.emit('session:revoked', { message: 'Сессия завершена. Войдите снова.' }); socket.disconnect(true); }
    }
  } catch (err) { logger.warn({ err }, 'Failed to disconnect device session sockets'); }
}

module.exports = { registerDriver, login, refresh, logout, sanitizeUser, revokeAllRefreshTokens, revokeSessionGeneration, publishSessionRevocation };
