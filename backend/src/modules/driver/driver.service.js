const { driverChatVisibility } = require('../chat/visibility');
const { afterCursor, beforeCursor, markRead } = require('../chat/cursors');
const { persistMessage } = require('../chat/persist-message');
const prisma = require('../../lib/prisma');
const { getIO } = require('../../lib/socket');
const rooms = require('../../sockets/rooms');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');
const districtsService = require('../districts/districts.service');
const { syncDriverDistrictRoom } = require('../../sockets/roomSync');
const { assertFreshGps } = require('./gps-eligibility');

async function getProfile(driverId, deviceId) {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    include: {
      user: { select: { id: true, phone: true, archivedPhone: true, deletedAt: true, fullName: true, avatarUrl: true, status: true, createdAt: true } },
      district: true,
      currentVehicle: true,
      vehicles: true
    }
  });
  if (!driver) return driver;
  return { ...require('./public-profile').publicDriverProfile(driver), canControlShift: !driver.isOnline || driver.shiftDeviceId === deviceId };
}

async function getBalance(userId) {
  // Defensive: every driver is created with a Balance row in the same
  // transaction as registration, but if data was seeded/imported
  // out-of-band, don't 500 - lazily create a zero balance instead.
  const balance = await prisma.balance.upsert({
    where: { userId },
    update: {},
    create: { userId, amount: 0 }
  });
  return balance;
}

function emitToInterestedRooms(driver, event, payload) {
  const io = getIO();
  // Chained .to() calls union the rooms into a single emit, so a socket
  // that happens to be in more than one of these (e.g. the driver's own
  // room AND their district room) still gets exactly one copy - two
  // separate emit() calls would double-deliver to it.
  let target = io.to(rooms.admins()).to(rooms.driver(driver.id)); // the driver always sees their own dot, regardless of balance/district gating
  if (driver.districtId) {
    target = target.to(rooms.district(driver.districtId));
  }
  target.emit(event, payload);
}

// The operating region comes from fresh shift GPS and saved boundaries.
// Outside all configured regions, keep the coordinates and clear the region.
async function updateLocation(driver, data) {
  const { lat, lng, heading, speed, accuracy, capturedAt } = data;
  const now = Date.now();
  if (capturedAt !== undefined && (now - capturedAt >= 60000 || capturedAt - now > 5000)) {
    throw ApiError.badRequest('GPS устарел. Обновите местоположение', { code: 'GPS_STALE' });
  }
  const recordedAt = new Date(capturedAt === undefined ? now : Math.min(now, capturedAt));

  const nearest = await districtsService.findDistrictForGpsPoint(lat, lng);
  const newDistrictId = nearest?.id ?? null;
  const districtChanged = newDistrictId !== driver.districtId;

  const updatedDriver = await prisma.$transaction(async tx => {
    await require('./shift-ownership').lockDeviceSession(tx, driver);
    await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driver.id} FOR UPDATE`;
    const current = await tx.driver.findUniqueOrThrow({ where: { id: driver.id } });
    require('./shift-ownership').assertShiftControl(current, driver.sessionDeviceId);
    if (!current.isOnline) throw ApiError.forbidden('Выйдите на линию, чтобы передавать местоположение', { code: 'DRIVER_OFFLINE' });
    const updated = await tx.driver.update({ where: { id: driver.id }, data: {
      lastLat: lat, lastLng: lng, lastHeading: heading, lastSpeed: speed,
      lastLocationAt: recordedAt, districtId: newDistrictId
    } });
    await tx.driverLocation.create({ data: { driverId: driver.id, lat, lng, heading, speed, accuracy, recordedAt } });
    return updated;
  });

  try {
    emitToInterestedRooms(updatedDriver, 'driver:location', {
      driverId: driver.id,
      lat,
      lng,
      heading,
      speed,
      recordedAt: updatedDriver.lastLocationAt.toISOString()
    });
  } catch (err) {
    // Socket layer being unavailable must never fail the REST write path.
    logger.warn({ err }, 'Failed to broadcast driver:location');
  }

  // Refresh the expiry even when the driver stays inside the same region.
  await syncDriverDistrictRoom(driver.id);
  if (districtChanged) await districtsService.broadcastDistrictStats();

  return updatedDriver;
}

async function setStatus(driver, data, credentialVersion) {
  const { updateCredentialedStatus } = require('./credentialed-status');
  const updated = await updateCredentialedStatus(driver.id, driver.userId, credentialVersion, data, driver.sessionDeviceId, driver.sessionDeviceVersion);

  if (data.isOnline === true && data.position) {
    try { emitToInterestedRooms(updated, 'driver:location', { driverId: driver.id, lat: Number(updated.lastLat), lng: Number(updated.lastLng), recordedAt: updated.lastLocationAt.toISOString() }); }
    catch (err) { logger.warn({ err }, 'Failed to broadcast initial shift position'); }
  }

  try {
    emitToInterestedRooms(updated, 'driver:status', {
      driverId: driver.id,
      isOnline: updated.isOnline,
      isAvailable: updated.isAvailable,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to broadcast driver:status');
  }

  // Toggling offline must immediately stop new-order broadcasts from
  // reaching this driver (and toggling back online must resume them) for
  // whatever sockets are already connected - a fresh connection is
  // evaluated from the database directly in sockets/index.js. Without this,
  // isOnline only ever affected admin's display and the "free drivers"
  // count, not actual order delivery.
  if (data.isOnline !== undefined) {
    await syncDriverDistrictRoom(driver.id);
  }

  // Online/available toggling changes the "free drivers" count on whichever
  // district card this driver currently belongs to.
  await districtsService.broadcastDistrictStats();

  return updated;
}

// Plate number / vehicle upsert. Used to be a driver self-service route;
// now only called from admin.service.js#updateVehicle - drivers can view
// their own vehicle (see getProfile above) but not change it themselves.
// If the driver already has a current vehicle, it's updated in place;
// otherwise a new one is created and set as current.
async function upsertVehicle(driver, data) {
  const vehicleData = {
    plateNumber: data.plateNumber,
    make: data.make,
    model: data.model,
    color: data.color
  };

  try {
    if (driver.currentVehicleId) {
      return await prisma.vehicle.update({ where: { id: driver.currentVehicleId }, data: vehicleData });
    }

    // vehicleSchema (both admin's and the old driver copy) always treated
    // make/model as optional - this UI only ever asks for a plate number,
    // nothing reads vehicle.make/model anywhere in the app - but the
    // Vehicle model itself has no `?`/@default on either column, so
    // Prisma's create() rejected an explicit `undefined` for them with a
    // PrismaClientValidationError ("Argument `make` is missing"), 500-ing
    // on literally every driver's very first plate save (confirmed in
    // production logs, predating this admin-side move). update() above
    // never hit this - Prisma treats undefined there as "leave unchanged",
    // only create() requires every non-optional column. Placeholders here
    // are the minimal fix without a schema migration on a live table.
    return await prisma.$transaction(async (tx) => {
      const created = await tx.vehicle.create({
        data: {
          ...vehicleData,
          make: vehicleData.make || 'Не указано',
          model: vehicleData.model || 'Не указано',
          driverId: driver.id,
          status: 'ACTIVE'
        }
      });
      await tx.driver.update({ where: { id: driver.id }, data: { currentVehicleId: created.id } });
      return created;
    });
  } catch (err) {
    if (err.code === 'P2002') {
      throw ApiError.conflict('Этот номер уже используется другим водителем');
    }
    throw err;
  }
}

// Same conversation model as admin.service.js#getDriverMessages: every
// Message where this driver's own user id is either sender or receiver.
// isBroadcast admin messages are included too (receiverId is null on
// those, but every driver is meant to see them - see sendMessage below for
// why an outgoing driver message never sets isBroadcast).
// The driver's own history for their profile screen (DriverProfile.vue) -
// same two lists the admin already sees for a driver
// (admin.service.js#getHistory), just scoped to the authenticated driver
// instead of taking a driverId, so one driver can never read another's.
async function getHistory(driver, { page, limit }) {
  const balance = await prisma.balance.findUnique({ where: { userId: driver.userId } });

  const [transactions, transactionsTotal, orders, ordersTotal] = await Promise.all([
    balance
      ? prisma.transaction.findMany({
          where: { balanceId: balance.id },
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit
        })
      : Promise.resolve([]),
    balance ? prisma.transaction.count({ where: { balanceId: balance.id } }) : Promise.resolve(0),
    prisma.order.findMany({
      where: { OR: [{ driverId: driver.id }, { assignments: { some: { driverId: driver.id } } }] },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: { district: true }
    }),
    prisma.order.count({ where: { OR: [{ driverId: driver.id }, { assignments: { some: { driverId: driver.id } } }] } })
  ]);

  // History never exposes customer contact; the call action belongs to active trips.
  const safeOrders = orders.map(({ clientPhone: _clientPhone, ...order }) => order);
  return {
    transactions: { items: transactions, total: transactionsTotal, page, limit },
    orders: { items: safeOrders, total: ordersTotal, page, limit }
  };
}

async function getMessages(driver, { page, limit, beforeMessageId }) {
  const { conversation: where, incoming } = await driverChatVisibility(driver.userId);

  // Anything the admin sent (i.e. not written by this driver) after they
  // last opened their chat. Returned alongside the messages so the app can
  // show a badge for messages that arrived while it was closed - previously
  // the unread counter only ever grew from live socket events, so those
  // were invisible until the driver happened to open the chat.
  const unreadWhere = {
    // Anything from the admin side: addressed to this driver, or sent to
    // all drivers at once. Broadcasts count too - "сообщение всем
    // водителям" is still a message they need to see, and lastChatReadAt
    // being per-driver keeps that correct for each of them individually.
    ...incoming,
    NOT: { senderId: driver.userId },
    AND: [afterCursor(driver.lastChatReadAt, driver.lastChatReadMessageId)]
  };

  const older = await beforeCursor(where, beforeMessageId);
  const [items, total, unread] = await Promise.all([
    prisma.message.findMany({
      where: { AND: [where, older] },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      skip: beforeMessageId ? 0 : (page - 1) * limit,
      take: limit
    }),
    prisma.message.count({ where }),
    prisma.message.count({ where: unreadWhere })
  ]);

  return { items: items.reverse(), total, page, limit, unread };
}

// Called when the driver actually opens their chat screen - everything the
// admin sent up to now counts as seen.
async function markChatRead(driver, throughMessageId) {
  const { incoming } = await driverChatVisibility(driver.userId);
  await markRead(driver.id, incoming, throughMessageId, 'lastChatReadAt', 'lastChatReadMessageId');
  // Reading is account-wide. A second signed-in device must clear its native
  // notification ledger too, while exact event IDs protect newer alerts.
  try {
    const current = await prisma.driver.findUnique({ where: { id: driver.id }, select: { lastChatReadAt: true, lastChatReadMessageId: true } });
    if (!current?.lastChatReadAt) return;
    const messages = await prisma.message.findMany({
      where: {
        NOT: { senderId: driver.userId },
        AND: [incoming, { OR: [
          { sentAt: { lt: current.lastChatReadAt } },
          ...(current.lastChatReadMessageId ? [{ sentAt: current.lastChatReadAt, id: { lte: current.lastChatReadMessageId } }] : [])
        ] }],
        sentAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }, select: { id: true }
    });
    const ids = messages.map((message) => `chat:${message.id}`);
    if (!ids.length) return;
    const installations = await prisma.notificationInstallation.findMany({ where: { driverId: driver.id }, select: { id: true } });
    await prisma.notificationDelivery.updateMany({ where: { installationId: { in: installations.map((row) => row.id) }, eventId: { in: ids } }, data: { acknowledgedAt: new Date(), invalidatedAt: new Date(), notBefore: new Date() } });
    getIO().to(rooms.driver(driver.id)).emit('chat:read', {
      lastChatReadAt: current.lastChatReadAt.toISOString(),
      lastChatReadMessageId: current.lastChatReadMessageId,
      eventIds: ids
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to synchronise chat notification read state');
  }
}

// A driver message has no single recipient (any on-duty admin can pick it
// up) - receiverId stays null, same shape Message already supports for the
// admin broadcast case, just mirrored for the other direction.
async function sendMessage(driver, body, clientMessageId) {
  const { message, created } = await persistMessage({ senderId: driver.userId, body, isBroadcast: false, clientMessageId });
  if (!created) return message;

  try {
    getIO()
      .to(rooms.admins())
      .emit('driver:message', { id: message.id, senderId: driver.userId, driverId: driver.id, senderName: driver.user?.fullName ?? null, body, sentAt: message.sentAt });
  } catch (err) {
    logger.warn({ err }, 'Failed to broadcast driver:message');
  }

  return message;
}

// Called once by the driver APK after @capacitor/push-notifications hands
// back an FCM registration token. Just storage - nothing in this codebase
// sends a push yet (needs a real Firebase project's server credentials,
// which this project doesn't have; see backend/README.md).
async function savePushToken(driver, token) {
  return prisma.driver.update({ where: { id: driver.id }, data: { pushToken: token } });
}

module.exports = {
  getProfile,
  getBalance,
  updateLocation,
  setStatus,
  upsertVehicle,
  getHistory,
  getMessages,
  markChatRead,
  sendMessage,
  savePushToken
};
