const { Prisma } = require('@prisma/client');
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { getIO } = require('../../lib/socket');
const rooms = require('../../sockets/rooms');
const logger = require('../../config/logger');
const { syncDriverDistrictRoom } = require('../../sockets/roomSync');
const districtsService = require('../districts/districts.service');
const driverService = require('../driver/driver.service');
const authService = require('../auth/auth.service');

const D = (value) => new Prisma.Decimal(value ?? 0);

function safeEmit(fn) {
  try {
    fn(getIO());
  } catch (err) {
    logger.warn({ err }, 'Failed to broadcast admin event');
  }
}

async function findDriverOrThrow(driverId) {
  const driver = await prisma.driver.findUnique({ where: { id: driverId }, include: { user: true } });
  if (!driver) throw ApiError.notFound('Водитель не найден');
  return driver;
}

// Raw FCM device tokens are internal routing plumbing (see
// driver.service.js#savePushToken) - nothing in the admin UI uses them, so
// they're stripped rather than echoed into list/detail responses.
function omitPushToken(driver) {
  if (!driver) return driver;
  const { pushToken, ...rest } = driver;
  void pushToken;
  return rest;
}

async function listDrivers({ status, page, limit }) {
  const where = status ? { status } : {};
  const [items, total] = await Promise.all([
    prisma.driver.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            phone: true,
            fullName: true,
            status: true,
            createdAt: true,
            lastLoginAt: true,
            balance: { select: { amount: true, currency: true } }
          }
        },
        district: true,
        currentVehicle: true
      }
    }),
    prisma.driver.count({ where })
  ]);
  return { items: await withUnreadFlag(items.map(omitPushToken)), total, page, limit };
}

// hasUnreadMessage: has this driver sent a message (to the shared admin
// inbox - see driver.service.js#sendMessage) more recently than any admin
// last opened their thread? Backs the badge in AdminChatList.vue /
// AdminNav.vue - see schema.prisma's Driver.lastReadByAdminAt comment for
// why read state is shared across admins rather than per-admin. One
// groupBy for the whole page instead of a query per driver.
async function withUnreadFlag(drivers) {
  if (drivers.length === 0) return drivers;
  const userIds = drivers.map((d) => d.userId);
  const lastMessages = await prisma.message.groupBy({
    by: ['senderId'],
    where: { senderId: { in: userIds }, isBroadcast: false },
    _max: { sentAt: true }
  });
  const lastMessageAtByUserId = new Map(lastMessages.map((m) => [m.senderId, m._max.sentAt]));
  return drivers.map((d) => {
    const lastMessageAt = lastMessageAtByUserId.get(d.userId) || null;
    const hasUnreadMessage = Boolean(lastMessageAt && (!d.lastReadByAdminAt || lastMessageAt > d.lastReadByAdminAt));
    return { ...d, hasUnreadMessage };
  });
}

// Backs AdminNav.vue's global "new message" badge - cheap enough to call on
// every admin page load (see AdminNav.vue's mounted()) since it only
// selects 3 columns per driver, not the full list/balance/vehicle payload
// listDrivers returns.
async function listUnreadDriverIds() {
  const drivers = await prisma.driver.findMany({
    where: { status: 'APPROVED' },
    select: { id: true, userId: true, lastReadByAdminAt: true }
  });
  const withFlags = await withUnreadFlag(drivers);
  return withFlags.filter((d) => d.hasUnreadMessage).map((d) => d.id);
}

// Called when an admin opens a driver's chat thread (see
// adminDrivers.js#fetchMessages) - clears the unread badge for every admin,
// not just the one who opened it, matching the shared-inbox model above.
async function markMessagesRead(driverId) {
  await findDriverOrThrow(driverId);
  await prisma.driver.update({ where: { id: driverId }, data: { lastReadByAdminAt: new Date() } });
}

// Single-driver detail - not just "find it in the already-fetched list" on
// the frontend, because a deep link / page refresh straight into a driver's
// detail screen must work without the list happening to be loaded first.
async function getDriver(driverId) {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    include: {
      user: {
        select: {
          id: true,
          phone: true,
          fullName: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          balance: { select: { amount: true, currency: true } }
        }
      },
      district: true,
      currentVehicle: true,
      vehicles: true,
      devices: { orderBy: { lastLoginAt: 'desc' } }
    }
  });
  if (!driver) throw ApiError.notFound('Водитель не найден');
  return omitPushToken(driver);
}

async function approveDriver(driverId, actorId) {
  const driver = await findDriverOrThrow(driverId);

  const updated = await prisma.driver.update({
    where: { id: driverId },
    data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: actorId, blockedAt: null, blockReason: null }
  });

  safeEmit((io) => {
    io.to(rooms.driver(driverId)).emit('driver:approved', { driverId });
  });

  logger.info({ driverId, actorId }, 'Driver approved');
  return updated;
}

async function blockDriver(driverId, actorId, reason) {
  const driver = await findDriverOrThrow(driverId);

  const updated = await prisma.driver.update({
    where: { id: driverId },
    data: {
      status: 'BLOCKED',
      blockedAt: new Date(),
      blockedBy: actorId,
      blockReason: reason || null,
      isOnline: false,
      isAvailable: false
    }
  });

  safeEmit((io) => {
    io.to(rooms.driver(driverId)).emit('driver:blocked', { driverId, reason: reason || null });
    // Force any currently-connected sockets for this driver to disconnect -
    // a JWT stays cryptographically valid until it expires, but the socket
    // session (and the next REST call, via requireApprovedDriver) must not.
    io.in(rooms.driver(driverId)).disconnectSockets(true);
  });

  // Blocking forces isOnline/isAvailable to false, which drops this driver
  // out of their district's "free drivers" count.
  await districtsService.broadcastDistrictStats();

  logger.info({ driverId, actorId, reason }, 'Driver blocked');
  return updated;
}

async function unblockDriver(driverId, actorId) {
  await findDriverOrThrow(driverId);
  const updated = await prisma.driver.update({
    where: { id: driverId },
    data: { status: 'APPROVED', blockedAt: null, blockReason: null, blockedBy: null, approvedAt: new Date(), approvedBy: actorId }
  });

  safeEmit((io) => io.to(rooms.driver(driverId)).emit('driver:approved', { driverId }));
  logger.info({ driverId, actorId }, 'Driver unblocked');
  return updated;
}

// Single-device login, with device memory (see schema.prisma's
// Driver.currentDeviceId comment): a driver logging in from a genuinely new
// device gets rejected and recorded here as pendingDeviceId instead. These
// two actions are how an admin resolves that - approve both binds the new
// device AND adds it to the driver's remembered devices (so it never needs
// approval again), and force-logs-out whatever device was previously
// active (same revocation reject doesn't need, since nothing changes for
// the currently-active device on a reject).
async function approveDevice(driverId, actorId) {
  const driver = await findDriverOrThrow(driverId);
  if (!driver.pendingDeviceId) {
    throw ApiError.badRequest('Нет заявки на смену устройства');
  }

  const updated = await prisma.$transaction(async (tx) => {
    await authService.revokeAllRefreshTokens(driver.user.id);
    const result = await tx.driver.update({
      where: { id: driverId },
      data: {
        currentDeviceId: driver.pendingDeviceId,
        currentDeviceLabel: driver.pendingDeviceLabel,
        pendingDeviceId: null,
        pendingDeviceLabel: null,
        pendingDeviceRequestedAt: null
      }
    });
    await tx.driverDevice.upsert({
      where: { driverId_deviceId: { driverId, deviceId: driver.pendingDeviceId } },
      update: { lastLoginAt: new Date(), ...(driver.pendingDeviceLabel ? { label: driver.pendingDeviceLabel } : {}) },
      create: { driverId, deviceId: driver.pendingDeviceId, label: driver.pendingDeviceLabel }
    });
    return result;
  });

  logger.info({ driverId, actorId }, 'Driver device change approved');
  return updated;
}

async function rejectDevice(driverId, actorId) {
  const driver = await findDriverOrThrow(driverId);
  if (!driver.pendingDeviceId) {
    throw ApiError.badRequest('Нет заявки на смену устройства');
  }

  const updated = await prisma.driver.update({
    where: { id: driverId },
    data: { pendingDeviceId: null, pendingDeviceLabel: null, pendingDeviceRequestedAt: null }
  });

  logger.info({ driverId, actorId }, 'Driver device change rejected');
  return updated;
}

// Hard-deletes a driver and everything personal to them. Most of it goes by
// cascade from the User row (driver, balance + its transactions, devices,
// GPS history, vehicles, refresh tokens - see schema.prisma's onDelete
// rules); the two relations that DON'T cascade need deciding explicitly:
//  - Orders: kept, with driverId nulled. A ride that happened, happened -
//    deleting the record would silently rewrite dispatch history, and
//    Order.driver is nullable precisely so an unassigned order is valid.
//  - Messages: deleted. Chat is personal to that driver and has no meaning
//    once the account is gone.
async function deleteDriver(driverId, actorId) {
  const driver = await findDriverOrThrow(driverId);

  await prisma.$transaction(async (tx) => {
    await tx.order.updateMany({ where: { driverId }, data: { driverId: null } });
    await tx.message.deleteMany({
      where: { OR: [{ senderId: driver.userId }, { receiverId: driver.userId }] }
    });
    await tx.user.delete({ where: { id: driver.userId } });
  });

  logger.info({ driverId, actorId }, 'Driver deleted');
  return { id: driverId };
}

async function adjustBalance(driverId, { amount, type, note }, actorId) {
  const driver = await findDriverOrThrow(driverId);

  const result = await prisma.$transaction(async (tx) => {
    const balance = await tx.balance.upsert({
      where: { userId: driver.userId },
      update: {},
      create: { userId: driver.userId, amount: 0 }
    });

    const newAmount = D(balance.amount).add(amount);
    if (newAmount.isNegative()) {
      throw ApiError.badRequest('Операция приведёт к отрицательному балансу');
    }

    await tx.balance.update({ where: { id: balance.id }, data: { amount: newAmount } });
    const transaction = await tx.transaction.create({
      data: {
        balanceId: balance.id,
        type,
        amount: D(amount),
        balanceAfter: newAmount,
        note,
        createdBy: actorId
      }
    });

    return { balance: { ...balance, amount: newAmount }, transaction };
  });

  safeEmit((io) => {
    // Also to admins: a live driver list ("Синхронизируй всё с админ
    // панелью") must reflect a balance change without the admin refetching.
    io.to(rooms.driver(driverId)).to(rooms.admins()).emit('balance:updated', {
      driverId,
      amount: result.balance.amount,
      reason: type,
      note: note || null
    });
  });

  // Keep the driver's district-room membership in sync with their balance
  // for any sockets that are ALREADY connected (a fresh connection is
  // evaluated from the database directly in sockets/index.js). Crossing
  // zero either grants or revokes "receives new order broadcasts" without
  // requiring the driver to reconnect.
  await syncDriverDistrictRoom(driverId, {
    previousDistrictId: driver.districtId,
    districtId: driver.districtId,
    eligible: driver.isOnline && result.balance.amount.greaterThan(0)
  });
  // A driver crossing zero balance drops out of (or back into) their
  // district's "free drivers" count.
  await districtsService.broadcastDistrictStats();

  logger.info({ driverId, actorId, amount, type }, 'Driver balance adjusted');
  return result;
}

async function getHistory(driverId, { page, limit }) {
  const driver = await findDriverOrThrow(driverId);
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
      where: { driverId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.order.count({ where: { driverId } })
  ]);

  return {
    driver: { id: driver.id, fullName: driver.user.fullName, phone: driver.user.phone, status: driver.status },
    balance,
    transactions: { items: transactions, total: transactionsTotal, page, limit },
    orders: { items: orders, total: ordersTotal, page, limit }
  };
}

async function sendMessage({ driverId, broadcast, title, body }, actorId) {
  if (broadcast) {
    const message = await prisma.message.create({
      data: { senderId: actorId, body, isBroadcast: true }
    });
    safeEmit((io) => {
      const payload = { id: message.id, senderId: actorId, title, body, sentAt: message.sentAt, broadcast: true };
      io.to(rooms.drivers()).emit('admin:message', payload);
      io.to(rooms.admins()).emit('admin:message', payload); // visibility on other admin dashboards
    });
    return message;
  }

  const driver = await findDriverOrThrow(driverId);
  const message = await prisma.message.create({
    data: { senderId: actorId, receiverId: driver.userId, body, isBroadcast: false }
  });

  safeEmit((io) => {
    const payload = { id: message.id, senderId: actorId, driverId, title, body, sentAt: message.sentAt, broadcast: false };
    io.to(rooms.driver(driverId)).emit('admin:message', payload);
    io.to(rooms.admins()).emit('admin:message', payload); // a second admin dashboard sees the reply too
  });
  return message;
}

// The chat thread with one driver: any Message where they were either the
// sender or the receiver (an admin-broadcast message never targets a single
// driver by receiverId, so it doesn't show up here - that's intentional,
// broadcasts aren't part of a 1:1 conversation view).
async function getDriverMessages(driverId, { page, limit }) {
  const driver = await findDriverOrThrow(driverId);
  const where = { OR: [{ senderId: driver.userId }, { receiverId: driver.userId }] };

  const [items, total] = await Promise.all([
    prisma.message.findMany({
      where,
      orderBy: { sentAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit
    }),
    prisma.message.count({ where })
  ]);

  return { items: items.reverse(), total, page, limit };
}

const ORDER_STATUS_GROUPS = {
  active: { in: ['NEW', 'ACCEPTED', 'WAITING', 'STARTED'] },
  // Narrower than "active" - a driver has actually taken it (as opposed to
  // NEW, still waiting for one). Added because "active" alone made it
  // impossible to see just the orders someone is actually working, without
  // the ones nobody has picked up yet mixed in.
  accepted: { in: ['ACCEPTED', 'WAITING', 'STARTED'] },
  completed: 'COMPLETED',
  cancelled: 'CANCELLED'
};

async function listOrders({ status, page, limit }) {
  const where = status && status !== 'all' ? { status: ORDER_STATUS_GROUPS[status] } : {};

  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        driver: { include: { user: { select: { fullName: true, phone: true } } } },
        district: true
      }
    }),
    prisma.order.count({ where })
  ]);

  return { items, total, page, limit };
}

// "Кто и что делал" - a real activity feed built from data the schema
// already tracks (Driver.approvedBy/blockedBy, Transaction.createdBy),
// resolved from opaque user-id strings to actual admin names in one batch
// lookup, rather than a dedicated audit-log table (none exists - adding one
// would mean a schema migration on a live database, out of scope for a
// frontend-driven feature request). Order cancellations are included too,
// but with no admin identity: Order has no "cancelledBy" column, so all we
// can honestly show for that one event type is the free-text cancelReason
// already recorded (which driver-side and admin-side cancels both set to a
// distinguishing default, e.g. "Отменено администратором") - not a name.
async function getActivity({ limit = 50 } = {}) {
  const [approvals, blocks, transactions, cancellations] = await Promise.all([
    prisma.driver.findMany({
      where: { approvedAt: { not: null } },
      orderBy: { approvedAt: 'desc' },
      take: limit,
      include: { user: { select: { fullName: true } } }
    }),
    prisma.driver.findMany({
      where: { blockedAt: { not: null } },
      orderBy: { blockedAt: 'desc' },
      take: limit,
      include: { user: { select: { fullName: true } } }
    }),
    prisma.transaction.findMany({
      where: { createdBy: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { balance: { include: { user: { select: { fullName: true } } } } }
    }),
    prisma.order.findMany({
      where: { status: 'CANCELLED' },
      orderBy: { cancelledAt: 'desc' },
      take: limit,
      include: { driver: { include: { user: { select: { fullName: true } } } } }
    })
  ]);

  const actorIds = new Set();
  approvals.forEach((d) => d.approvedBy && actorIds.add(d.approvedBy));
  blocks.forEach((d) => d.blockedBy && actorIds.add(d.blockedBy));
  transactions.forEach((t) => t.createdBy && actorIds.add(t.createdBy));

  const actors = actorIds.size
    ? await prisma.user.findMany({ where: { id: { in: [...actorIds] } }, select: { id: true, fullName: true } })
    : [];
  const actorName = new Map(actors.map((a) => [a.id, a.fullName]));

  const events = [
    ...approvals.map((d) => ({
      id: `approve-${d.id}`,
      type: 'driver_approved',
      at: d.approvedAt,
      actor: actorName.get(d.approvedBy) || null,
      summary: `Одобрен водитель ${d.user.fullName}`
    })),
    ...blocks.map((d) => ({
      id: `block-${d.id}`,
      type: 'driver_blocked',
      at: d.blockedAt,
      actor: actorName.get(d.blockedBy) || null,
      summary: `Заблокирован водитель ${d.user.fullName}${d.blockReason ? ` (${d.blockReason})` : ''}`
    })),
    ...transactions.map((t) => ({
      id: `tx-${t.id}`,
      type: 'balance_adjusted',
      at: t.createdAt,
      actor: actorName.get(t.createdBy) || null,
      summary: `Баланс ${t.balance.user.fullName}: ${Number(t.amount) >= 0 ? '+' : ''}${t.amount} TMT (${t.type})`
    })),
    ...cancellations.map((o) => ({
      id: `cancel-${o.id}`,
      type: 'order_cancelled',
      at: o.cancelledAt,
      actor: null,
      summary: `Отменён заказ ${o.driver ? 'у ' + o.driver.user.fullName : '(не назначен)'}${o.cancelReason ? `: ${o.cancelReason}` : ''}`
    }))
  ];

  events.sort((a, b) => new Date(b.at) - new Date(a.at));
  return events.slice(0, limit);
}

// Plate number / vehicle details used to be self-service (driver-editable,
// see driver.service.js#upsertVehicle's original comment) - moved here so
// only admins can change what's essentially an identity/compliance detail;
// the driver-facing POST /driver/vehicle route has been removed entirely
// (not just hidden in the UI) so this is enforced server-side, not by
// convention. Reuses the exact same upsert logic driver.service.js already
// had (create-if-none, update-in-place otherwise, same plate uniqueness
// check) so behavior is unchanged - only who's allowed to call it.
async function updateVehicle(driverId, data) {
  const driver = await findDriverOrThrow(driverId);
  return driverService.upsertVehicle(driver, data);
}

// Backs the "Границы районов" editor (AdminDistrictBoundaries.vue) - unlike
// GET /districts (districts.service.js#listDistrictsWithStats, used by the
// driver/admin overview cards), this returns the raw geometry an editor
// needs (center/radius/boundary) instead of live order/driver counts.
async function listDistricts() {
  return prisma.district.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, centerLat: true, centerLng: true, radiusKm: true, boundary: true }
  });
}

// `boundary` has already passed districtBoundarySchema (array of rings,
// each >= 3 [lat,lng] points) by the time this runs - see
// utils/geo.js#findDistrictByBoundary for how it's actually used once saved.
async function updateDistrictBoundary(districtId, boundary) {
  const district = await prisma.district.findUnique({ where: { id: districtId } });
  if (!district) throw ApiError.notFound('Район не найден');
  return prisma.district.update({ where: { id: districtId }, data: { boundary } });
}

module.exports = {
  listDrivers,
  getDriver,
  approveDriver,
  blockDriver,
  unblockDriver,
  approveDevice,
  rejectDevice,
  deleteDriver,
  adjustBalance,
  getHistory,
  sendMessage,
  getDriverMessages,
  listOrders,
  getActivity,
  updateVehicle,
  listDistricts,
  updateDistrictBoundary,
  markMessagesRead,
  listUnreadDriverIds
};
