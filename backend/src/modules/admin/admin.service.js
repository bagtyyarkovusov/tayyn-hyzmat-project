const { beforeCursor, markRead } = require('../chat/cursors');
const { persistMessage } = require('../chat/persist-message');
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
const { hashPassword } = require('../../utils/password');

const { MAX_WALLET_AMOUNT } = require('../../utils/money-policy');
const { lockedBalance } = require('../balance/locked-balance');

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
  const { orders, ...rest } = require('../driver/public-profile').publicDriverProfile(driver);
  return { ...rest, accountDeleted: Boolean(rest.user?.deletedAt || rest.user?.status === 'BLOCKED'), hasActiveTrip: Boolean(orders?.length), isAvailable: rest.isAvailable && !orders?.length };
}

async function createDriver({ phone, fullName, password }, actorId) {
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      role: 'DRIVER', phone, fullName, passwordHash,
      driver: { create: { status: 'APPROVED', approvedAt: new Date(), approvedBy: actorId } },
      balance: { create: { amount: 0, currency: 'TMT' } }
    },
    select: { driver: { select: { id: true } } }
  });
  const driver = await getDriver(user.driver.id);
  safeEmit(io => io.to(rooms.admins()).emit('driver:registered', driver));
  return driver;
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
        orders: { where: { status: { in: ['ACCEPTED', 'WAITING', 'STARTED'] } }, select: { id: true }, take: 1 },
        user: {
          select: {
            id: true,
            phone: true,
            archivedPhone: true,
            deletedAt: true,
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
  const lastMessages = await prisma.message.findMany({
    where: { senderId: { in: userIds }, isBroadcast: false },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    distinct: ['senderId'],
    select: { id: true, senderId: true, sentAt: true }
  });
  const latestByUserId = new Map(lastMessages.map(message => [message.senderId, message]));
  return drivers.map(driver => {
    const latest = latestByUserId.get(driver.userId);
    const hasUnreadMessage = Boolean(latest && (!driver.lastReadByAdminAt || latest.sentAt > driver.lastReadByAdminAt ||
      (latest.sentAt.getTime() === driver.lastReadByAdminAt.getTime() && driver.lastReadByAdminMessageId && latest.id > driver.lastReadByAdminMessageId)));
    return { ...driver, hasUnreadMessage };
  });
}

// Backs AdminNav.vue's global "new message" badge - cheap enough to call on
// every admin page load (see AdminNav.vue's mounted()) since it only
// selects 3 columns per driver, not the full list/balance/vehicle payload
// listDrivers returns.
async function listUnreadDriverIds() {
  const drivers = await prisma.driver.findMany({
    where: { status: 'APPROVED' },
    select: { id: true, userId: true, lastReadByAdminAt: true, lastReadByAdminMessageId: true }
  });
  const withFlags = await withUnreadFlag(drivers);
  return withFlags.filter((d) => d.hasUnreadMessage).map((d) => d.id);
}

// Called when an admin opens a driver's chat thread (see
// adminDrivers.js#fetchMessages) - clears the unread badge for every admin,
// not just the one who opened it, matching the shared-inbox model above.
async function markMessagesRead(driverId, throughMessageId) {
  const driver = await findDriverOrThrow(driverId);
  await markRead(driverId, { senderId: driver.userId, isBroadcast: false }, throughMessageId, 'lastReadByAdminAt', 'lastReadByAdminMessageId');
  try {
    getIO().to(rooms.admins()).emit('admin:messages-read', { driverId, throughMessageId });
  } catch (err) {
    logger.debug({ err }, 'Admin read cursor broadcast skipped');
  }
}

// Single-driver detail - not just "find it in the already-fetched list" on
// the frontend, because a deep link / page refresh straight into a driver's
// detail screen must work without the list happening to be loaded first.
async function getDriver(driverId) {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    include: {
      orders: { where: { status: { in: ['ACCEPTED', 'WAITING', 'STARTED'] } }, select: { id: true }, take: 1 },
      user: {
        select: {
          id: true,
          phone: true,
          archivedPhone: true,
          deletedAt: true,
          fullName: true,
          status: true,
          createdAt: true,
          lastLoginAt: true,
          balance: { select: { amount: true, currency: true } }
        }
      },
      district: true,
      currentVehicle: true,
      vehicles: true
    }
  });
  if (!driver) throw ApiError.notFound('Водитель не найден');
  return omitPushToken(driver);
}

async function approveDriver(driverId, actorId) {
  const driver = await findDriverOrThrow(driverId);
  const updated = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${driver.userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: driver.userId } });
    if (user.status === 'BLOCKED') throw ApiError.conflict('Аккаунт удалён. Восстановление недоступно', { code: 'ACCOUNT_DELETED' });
    return tx.driver.update({
      where: { id: driverId },
      data: { status: 'APPROVED', approvedAt: new Date(), approvedBy: actorId, blockedAt: null, blockReason: null }
    });
  });

  safeEmit((io) => {
    io.to(rooms.driver(driverId)).emit('driver:approved', { driverId });
  });

  await districtsService.broadcastDistrictStats();
  logger.info({ driverId, actorId }, 'Driver approved');
  return updated;
}

async function blockDriver(driverId, actorId, reason) {
  const driver = await findDriverOrThrow(driverId);

  const updated = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${driver.userId} FOR UPDATE`;
    await authService.revokeSessionGeneration(tx, driver.userId);
    const result = await tx.driver.update({
      where: { id: driverId },
      data: {
        status: 'BLOCKED', blockedAt: new Date(), blockedBy: actorId,
        blockReason: reason || null, isOnline: false, shiftDeviceId: null, isAvailable: false
      }
    });
    return result;
  });
  await authService.publishSessionRevocation(driver.userId);

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
  const driver = await findDriverOrThrow(driverId);
  const updated = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${driver.userId} FOR UPDATE`;
    const user = await tx.user.findUniqueOrThrow({ where: { id: driver.userId } });
    if (user.status === 'BLOCKED') throw ApiError.conflict('Аккаунт удалён. Восстановление недоступно', { code: 'ACCOUNT_DELETED' });
    return tx.driver.update({
      where: { id: driverId },
      data: { status: 'APPROVED', blockedAt: null, blockReason: null, blockedBy: null, approvedAt: new Date(), approvedBy: actorId }
    });
  });

  safeEmit((io) => io.to(rooms.driver(driverId)).emit('driver:approved', { driverId }));
  await districtsService.broadcastDistrictStats();
  logger.info({ driverId, actorId }, 'Driver unblocked');
  return updated;
}

// End access on lost installations without altering the account or its trip.
async function signOutEverywhere(driverId, actorId) {
  const driver = await findDriverOrThrow(driverId);
  await authService.revokeAllRefreshTokens(driver.userId);
  safeEmit(io => io.to(rooms.admins()).emit('driver:updated', { driverId }));
  logger.info({ driverId, actorId }, 'Driver signed out on all installations');
  return { message: 'Все сеансы водителя завершены. Для продолжения нужно войти снова' };
}

// Permanently end account access while retaining ledger and trip attribution.
async function deleteDriver(driverId, actorId) {
  const driver = await findDriverOrThrow(driverId);
  await prisma.$transaction(async (tx) => {
    // Credential commands lock users first; order commands lock the driver.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${driver.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId} FOR UPDATE`;
    const activeTrip = await tx.order.findFirst({
      where: { driverId, status: { in: ['ACCEPTED', 'WAITING', 'STARTED'] } }, select: { id: true }
    });
    if (activeTrip) throw ApiError.conflict('Сначала завершите или отмените активную поездку');
    const currentUser = await tx.user.findUniqueOrThrow({ where: { id: driver.userId } });
    if (currentUser.deletedAt) return;
    await tx.user.update({ where: { id: driver.userId }, data: { status: 'BLOCKED',
      archivedPhone: currentUser.phone, deletedAt: new Date(), phone: `deleted:${currentUser.id}` } });
    await authService.revokeSessionGeneration(tx, driver.userId);
    await tx.driver.update({ where: { id: driverId }, data: {
      status: 'BLOCKED', blockedAt: new Date(), blockedBy: actorId,
      blockReason: 'Аккаунт удалён', isOnline: false, isAvailable: false,
      pendingDeviceId: null, pendingDeviceLabel: null, pendingDeviceRequestedAt: null
    } });
  });
  safeEmit(io => {
    io.to(rooms.driver(driverId)).emit('session:revoked', { message: 'Аккаунт удалён' });
    io.in(rooms.driver(driverId)).disconnectSockets(true);
    io.to(rooms.admins()).emit('driver:updated', { driverId });
  });
  try { await districtsService.broadcastDistrictStats(); }
  catch (err) { logger.warn({ err, driverId }, 'Failed to broadcast driver deletion'); }
  logger.info({ driverId, actorId }, 'Driver account deleted; financial history retained');
  return { id: driverId };
}

async function adjustBalance(driverId, { amount, type, note, operationId }, actorId) {
  const driver = await findDriverOrThrow(driverId);

  const result = await prisma.$transaction(async (tx) => {
    // Serialize one actor intent even if a mistaken retry names a different driver.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${actorId}:${operationId}`}, 0))`;
    const previous = await tx.transaction.findUnique({
      where: { createdBy_operationId: { createdBy: actorId, operationId } }, include: { balance: true }
    });
    if (previous) {
      if (previous.balance.userId !== driver.userId || previous.type !== type ||
          !D(previous.amount).eq(amount) || (previous.note || '') !== (note || '')) {
        throw ApiError.conflict('Идентификатор операции уже использован для другого действия');
      }
      const { balance: savedBalance, ...transaction } = previous;
      return { balance: { ...savedBalance, amount: previous.balanceAfter }, transaction, replayed: true };
    }
    // Same lock order as order mutations: driver, optional order, wallet.
    await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId} FOR UPDATE`;
    const balance = await lockedBalance(tx, driver.userId);

    const newAmount = D(balance.amount).add(amount);
    // Keep room to return an active trip's actual debit on cancellation.
    // Locking the driver serializes this check with accept/cancel/complete.
    const refundable = await tx.transaction.aggregate({
      where: { balanceId: balance.id, type: 'PAYMENT', order: { status: { in: ['ACCEPTED', 'WAITING', 'STARTED'] } } },
      _sum: { amount: true }
    });
    const reservedRefund = D(refundable._sum.amount).abs();
    if (newAmount.add(reservedRefund).gt(MAX_WALLET_AMOUNT)) {
      throw ApiError.badRequest('Превышен максимальный баланс с учётом возможного возврата за поездку');
    }
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
        createdBy: actorId,
        operationId
      }
    });

    return { balance: { ...balance, amount: newAmount }, transaction };
  });

  if (result.replayed) return result;

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
  try { await syncDriverDistrictRoom(driverId); }
  catch (err) { logger.warn({ err, driverId }, 'Failed to synchronize wallet room after commit'); }
  // A driver crossing zero balance drops out of (or back into) their
  // district's "free drivers" count.
  try { await districtsService.broadcastDistrictStats(); }
  catch (err) { logger.warn({ err, driverId }, 'Failed to broadcast wallet update after commit'); }

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
    driver: { id: driver.id, fullName: driver.user.fullName, phone: driver.user.archivedPhone || driver.user.phone, status: driver.status },
    balance,
    transactions: { items: transactions, total: transactionsTotal, page, limit },
    orders: { items: orders, total: ordersTotal, page, limit }
  };
}

async function sendMessage({ driverId, broadcast, title, body, clientMessageId }, actorId) {
  if (broadcast) {
    const { message, created } = await persistMessage({ senderId: actorId, body, isBroadcast: true, clientMessageId });
    if (!created) return message;
    require('../notifications/notifications').wake();
    safeEmit((io) => {
      const payload = { id: message.id, senderId: actorId, title, body, sentAt: message.sentAt, broadcast: true };
      io.to(rooms.drivers()).emit('admin:message', payload);
      io.to(rooms.admins()).emit('admin:message', payload); // visibility on other admin dashboards
    });
    return message;
  }

  const driver = await findDriverOrThrow(driverId);
  const { message, created } = await persistMessage({ senderId: actorId, receiverId: driver.userId, body, isBroadcast: false, clientMessageId });
  if (!created) return message;
  require('../notifications/notifications').wake();

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
async function getDriverMessages(driverId, { page, limit, beforeMessageId }) {
  const driver = await findDriverOrThrow(driverId);
  const where = { OR: [{ senderId: driver.userId }, { receiverId: driver.userId }] };

  const older = await beforeCursor(where, beforeMessageId);
  const [items, total] = await Promise.all([
    prisma.message.findMany({
      where: { AND: [where, older] },
      orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
      skip: beforeMessageId ? 0 : (page - 1) * limit,
      take: limit
    }),
    prisma.message.count({ where })
  ]);

  return { items: items.reverse(), total, page, limit };
}

const ORDER_STATUS_GROUPS = {
  waiting: 'NEW',
  active: { in: ['NEW', 'ACCEPTED', 'WAITING', 'STARTED'] },
  // Narrower than "active" - a driver has actually taken it (as opposed to
  // NEW, still waiting for one). Added because "active" alone made it
  // impossible to see just the orders someone is actually working, without
  // the ones nobody has picked up yet mixed in.
  accepted: { in: ['ACCEPTED', 'WAITING', 'STARTED'] },
  completed: 'COMPLETED',
  cancelled: 'CANCELLED'
};

async function listOrders({ status, page, limit, customerPhone, driverPhone, orderNumber }) {
  const where = {
    ...(status && status !== "all"
      ? { status: ORDER_STATUS_GROUPS[status] }
      : {}),
    ...(customerPhone ? { clientPhone: customerPhone } : {}),
    ...(orderNumber ? { orderNumber } : {}),
  };
  if (driverPhone) {
    // Resolve current and archived driver phones first so historical orders
    // remain searchable after deletion. Earlier credential phone values are
    // not retained when a driver's phone is edited.
    const users = await prisma.user.findMany({
      where: {
        role: "DRIVER",
        OR: [{ phone: driverPhone }, { archivedPhone: driverPhone }],
      },
      select: { driver: { select: { id: true } } },
    });
    where.driverId = {
      in: users.flatMap(({ driver }) => (driver ? [driver.id] : [])),
    };
  }

  const [items, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        driver: {
          include: {
            user: {
              select: { fullName: true, phone: true, archivedPhone: true },
            },
          },
        },
        district: true,
        resolutionAudits: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { actor: { select: { fullName: true } } },
        },
      },
    }),
    prisma.order.count({ where }),
  ]);

  const now = Date.now();
  return {
    items: items.map((order) => ({
      ...order,
      driver: require("../driver/public-profile").publicDriverProfile(
        order.driver,
      ),
      startedAgeSeconds:
        order.status === "STARTED" && order.startedAt
          ? Math.max(0, Math.floor((now - order.startedAt.getTime()) / 1000))
          : null,
      needsCompletion:
        order.status === "STARTED" && order.startedAt
          ? now - order.startedAt.getTime() >= 15 * 60 * 1000
          : false,
    })),
    total,
    page,
    limit,
  };
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
  createDriver,
  listDrivers,
  getDriver,
  approveDriver,
  blockDriver,
  unblockDriver,
  signOutEverywhere,
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
