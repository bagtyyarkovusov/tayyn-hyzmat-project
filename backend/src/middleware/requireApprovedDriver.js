const prisma = require('../lib/prisma');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { releaseExpiredShift } = require('../modules/driver/shift-ownership');

// An access token stays valid for its full lifetime even if an admin blocks
// the driver a second later - so every driver-only route re-checks the
// CURRENT status in the database instead of trusting the JWT claim. This is
// what makes "admin blocks a driver -> access denied immediately" actually
// true rather than "true after the token happens to expire".
const requireApprovedDriver = asyncHandler(async (req, res, next) => {
  if (!req.user || req.user.role !== 'DRIVER') {
    throw ApiError.forbidden('Доступ только для водителей');
  }

  const driver = await prisma.driver.findUnique({
    where: { id: req.user.driverId },
    include: { user: true }
  });

  if (!driver) {
    throw ApiError.notFound('Профиль водителя не найден');
  }

  if (driver.user.status === 'BLOCKED') {
    throw ApiError.forbidden('Ваш аккаунт заблокирован');
  }

  if (driver.status === 'PENDING') {
    throw ApiError.forbidden('Ваш аккаунт ожидает подтверждения', { status: 'PENDING' });
  }

  if (driver.status === 'BLOCKED') {
    throw ApiError.forbidden(
      driver.blockReason ? `Ваш аккаунт заблокирован: ${driver.blockReason}` : 'Ваш аккаунт заблокирован',
      { status: 'BLOCKED' }
    );
  }

  if (driver.isOnline || driver.shiftDeviceId) {
    const effective = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${driver.userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driver.id} FOR UPDATE`;
      return releaseExpiredShift(tx, driver.id);
    });
    const released = driver.isOnline && !effective.isOnline;
    Object.assign(driver, effective);
    if (released) {
      try { await require('../modules/native-shift/native-shift.service').publishUserShiftState(driver.userId); }
      catch (err) { require('../config/logger').warn({ err }, 'Failed to publish expired shift state'); }
    }
  }
  req.driver = { ...driver, sessionDeviceId: req.user.deviceId, sessionDeviceVersion: req.user.deviceVersion, sessionCredentialVersion: req.user.credentialVersion };
  next();
});

module.exports = requireApprovedDriver;
