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
  return rest;
}

// Registers a new DRIVER account. Client/admin creation are intentionally
// not exposed on this public endpoint - admins are provisioned via seed/an
// internal process, and there is no client-facing flow yet (see migration
// plan). The driver starts in Driver.status = PENDING and cannot log in
// until an admin approves them.
async function registerDriver({ phone, fullName, password }) {
  const existing = await prisma.user.findUnique({ where: { phone } });
  if (existing) {
    throw ApiError.conflict('Пользователь с таким номером телефона уже зарегистрирован');
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
        balance: { create: { amount: 0 } }
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

async function issueTokenPair(user) {
  const payload = {
    sub: user.id,
    credentialVersion: user.credentialVersion,
    role: user.role,
    driverId: user.driver ? user.driver.id : undefined,
    adminId: user.admin ? user.admin.id : undefined
  };

  const accessToken = signAccessToken(payload);
  const refreshToken = generateRefreshToken();

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      credentialVersion: user.credentialVersion,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + parseDurationToMs(env.jwtRefreshExpiresIn))
    }
  });

  return { accessToken, refreshToken };
}

// Force-logs-out whatever device was previously active: revokes every
// still-valid refresh token for this user, so its next silent refresh
// attempt fails and apiClient.js's interceptor sends it back to the login
// screen (the current access token, being a stateless JWT, keeps working
// until its own short expiry - there's no way to invalidate that
// instantly, only the refresh that would normally keep the session alive).
async function revokeAllRefreshTokens(userId) {
  await require('../native-shift/native-shift.service').revokeUserShift(userId);
  // Backdated deliberately, past ROTATION_GRACE_MS. refresh() lets a
  // just-rotated token through for a minute to survive concurrent refreshes
  // - but a force-logout must be immediate, otherwise the device being
  // kicked could refresh inside that window and hand itself a brand new,
  // un-revoked token, staying signed in forever. Backdating puts these
  // outside the grace window the moment they're written.
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(Date.now() - ROTATION_GRACE_MS - 1000) }
  });
}

async function login({ phone, password, deviceId, deviceLabel }) {
  const user = await prisma.user.findUnique({
    where: { phone },
    include: { driver: true, admin: true, balance: true }
  });

  // Same generic message for "no such user" and "wrong password" to avoid
  // leaking which phone numbers are registered.
  if (!user || !(await comparePassword(password, user.passwordHash))) {
    throw ApiError.unauthorized('Неверный номер телефона или пароль');
  }

  if (user.status === 'BLOCKED') {
    throw ApiError.forbidden('Ваш аккаунт заблокирован');
  }

  if (user.role === 'DRIVER') {
    if (!user.driver) {
      throw ApiError.notFound('Профиль водителя не найден');
    }
    if (user.driver.status === 'PENDING') {
      throw ApiError.forbidden('Ваш аккаунт ожидает подтверждения', { status: 'PENDING' });
    }
    if (user.driver.status === 'BLOCKED') {
      throw ApiError.forbidden(
        user.driver.blockReason
          ? `Ваш аккаунт заблокирован: ${user.driver.blockReason}`
          : 'Ваш аккаунт заблокирован',
        { status: 'BLOCKED' }
      );
    }

    // Single-device login, with device memory (see schema.prisma's
    // Driver.currentDeviceId comment for the full model). `deviceId` is
    // optional so a not-yet-updated driver client (or a login that
    // genuinely doesn't care, e.g. tests) isn't locked out by a rule it
    // doesn't participate in - the check only ever runs when the caller
    // actually sends one.
    if (deviceId) {
      const isFirstLoginEver = !user.driver.currentDeviceId;
      const isAlreadyActive = user.driver.currentDeviceId === deviceId;
      const isKnownDevice =
        !isAlreadyActive && Boolean(await prisma.driverDevice.findUnique({ where: { driverId_deviceId: { driverId: user.driver.id, deviceId } } }));

      if (isFirstLoginEver || isKnownDevice) {
        if (!isFirstLoginEver) {
          // Switching to a device that's been approved before - no admin
          // needed, but the device that WAS active gets logged out.
          await revokeAllRefreshTokens(user.id);
        }
        await prisma.driver.update({
          where: { id: user.driver.id },
          data: {
            currentDeviceId: deviceId,
            currentDeviceLabel: deviceLabel || null,
            pendingDeviceId: null,
            pendingDeviceLabel: null,
            pendingDeviceRequestedAt: null
          }
        });
        await prisma.driverDevice.upsert({
          where: { driverId_deviceId: { driverId: user.driver.id, deviceId } },
          update: { lastLoginAt: new Date(), ...(deviceLabel ? { label: deviceLabel } : {}) },
          create: { driverId: user.driver.id, deviceId, label: deviceLabel || null }
        });
      } else if (!isAlreadyActive) {
        if (user.driver.pendingDeviceId !== deviceId) {
          await prisma.driver.update({
            where: { id: user.driver.id },
            data: { pendingDeviceId: deviceId, pendingDeviceLabel: deviceLabel || null, pendingDeviceRequestedAt: new Date() }
          });
        }
        throw ApiError.forbidden('Вход с этого устройства требует подтверждения администратора. Заявка отправлена.', {
          code: 'DEVICE_APPROVAL_PENDING'
        });
      }
    }
  }

  const { accessToken, refreshToken } = await issueTokenPair(user);

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  return {
    accessToken,
    refreshToken,
    user: sanitizeUser(user)
  };
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

  // Rotate: revoke the used token and issue a brand new pair. This limits
  // the blast radius if a refresh token is ever stolen/replayed. Already-
  // revoked-but-within-grace tokens keep their original revokedAt, so the
  // window can't be extended indefinitely by hammering the same token.
  if (!stored.revokedAt) {
    await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  }
  const pair = await issueTokenPair(user);

  return { ...pair, user: sanitizeUser(user) };
}

async function logout(refreshToken) {
  const tokenHash = hashRefreshToken(refreshToken);
  const session = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (session) await require('../native-shift/native-shift.service').revokeUserShift(session.userId);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

module.exports = { registerDriver, login, refresh, logout, sanitizeUser, revokeAllRefreshTokens };
