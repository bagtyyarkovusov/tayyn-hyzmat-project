const { Prisma } = require('@prisma/client');
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { getIO } = require('../../lib/socket');
const rooms = require('../../sockets/rooms');
const logger = require('../../config/logger');
const districtsService = require('../districts/districts.service');
const { haversineDistanceKm } = require('../../utils/geo');
const { debitOrderQuoteOnAcceptance, cancelOrderFunding, acceptedPrice } = require('./order-charge');
const { orderPayload, invalidation, notificationEventId } = require('./order-payload');
const { randomUUID } = require('node:crypto');
const { lockedBalance } = require('../balance/locked-balance');
const { assertShiftControl, lockDeviceSession } = require('../driver/shift-ownership');
const { assertOrderEligibility } = require('../driver/gps-eligibility');
const { refreshOrderRecipients } = require('../../sockets/roomSync');
const notifications = require('../notifications/notifications');

const D = (value) => new Prisma.Decimal(value ?? 0);
const NEEDS_COMPLETION_AFTER_MS = 15 * 60 * 1000;

// --- Tariff, exactly as specified ---
// Ожидание в точке А: первые 3 минуты бесплатно, затем +1 манат за каждые
// полные 1.3 минуты (округление вверх - как в паркомате: даже секунда в
// новом интервале оплачивается им целиком).
const WAIT_FREE_MINUTES = 3;
const WAIT_INCREMENT_MINUTES = 1.3;
const WAIT_INCREMENT_FEE = 1;
// Поездка: 1 км = 1.2 маната.
const DISTANCE_RATE_PER_KM = 1.2;

function safeEmit(fn) {
  try {
    fn(getIO());
  } catch (err) {
    logger.warn({ err }, 'Failed to broadcast order event');
  }
}

function calculateWaitFee(arrivedAt, endAt) {
  const elapsedMinutes = (endAt.getTime() - arrivedAt.getTime()) / 60000;
  const billableMinutes = elapsedMinutes - WAIT_FREE_MINUTES;
  if (billableMinutes <= 0) return D(0);
  const increments = Math.ceil(billableMinutes / WAIT_INCREMENT_MINUTES);
  return D(increments * WAIT_INCREMENT_FEE);
}

// Distance actually driven during STARTED is derived from the same GPS
// pings the driver app already sends every 5s (POST /driver/location) -
// summed as consecutive haversine deltas between startedAt and now. This is
// why a driver can only have one active order at a time (isAvailable=false
// on accept): the location history in that window is unambiguously theirs.
async function calculateDistanceKm(driverId, fromDate, toDate, client = prisma) {
  const points = await client.driverLocation.findMany({
    where: { driverId, recordedAt: { gte: fromDate, lte: toDate } },
    orderBy: { recordedAt: 'asc' },
    select: { lat: true, lng: true }
  });

  let totalKm = 0;
  for (let i = 1; i < points.length; i++) {
    totalKm += haversineDistanceKm(
      { lat: Number(points[i - 1].lat), lng: Number(points[i - 1].lng) },
      { lat: Number(points[i].lat), lng: Number(points[i].lng) }
    );
  }
  return totalKm;
}

async function hasPositiveBalance(userId) {
  const balance = await prisma.balance.findUnique({ where: { userId } });
  return Boolean(balance) && balance.amount.greaterThan(0);
}

// A driver has at most one order "in progress" at a time - this is what
// getCurrent() below returns, and what accept() checks against before
// letting a second one through.
const ACTIVE_DRIVER_ORDER_STATUSES = ['ACCEPTED', 'WAITING', 'STARTED'];

// The pickup/dropoff address strings are safe to show pre-acceptance ("Новый
// заказ" popup needs Откуда/Куда/Цена) - the client's phone number is not:
// it's only revealed once a driver has actually committed to the ride (see
// README "Заказы"). Explicit `select` here, not a client-side hide, so an
// un-accepted order never even leaves the server with a phone number in it.
const AVAILABLE_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  offerAttemptId: true,
  offerAttemptKind: true,
  pickupLat: true,
  pickupLng: true,
  pickupAddress: true,
  dropoffLat: true,
  dropoffLng: true,
  dropoffAddress: true,
  priceEstimated: true,
  districtId: true,
  createdAt: true,
  district: true,
  note: true,
  publicReleasedGloballyAt: true,
  publicRegionOnlyUntil: true,
  broadcastAfterPrivateExpiry: true,
  privateOfferStoppedAt: true,
  privateOfferExpiresAt: true
};

// districtId lets a driver look at any of the 9 district cards, not just
// the one they're physically in (tapping a district square in the app -
// see DistrictCard.vue) - defaults to the driver's own district when
// omitted, same behavior as before this parameter existed. This is a
// read-only view. Every public order is immediately claimable from any
// region; its region only determines who receives the initial popup.
async function listAvailable(driver, districtId, scope = 'district') {
  assertOrderEligibility(driver);
  await expirePrivateOffers();
  if (!(await hasPositiveBalance(driver.userId))) {
    return [];
  }
  // Do not advertise a second order while this driver has an active trip.
  // The accept transaction remains authoritative at claim time.
  if (!driver.isAvailable) return [];

  const targetDistrictId = districtId || driver.districtId;
  const items = await prisma.order.findMany({
    where: {
      driverId: null,
      status: 'NEW',
      privateOfferDriverId: null,
      privateOfferStoppedAt: null,
      ...(scope === 'all'
        ? {}
        : targetDistrictId
          ? { districtId: targetDistrictId }
          : {})
    },
    orderBy: { createdAt: 'asc' },
    select: AVAILABLE_ORDER_SELECT
  });
  return items.map(orderPayload);
}

// The driver's in-progress order, if any - needed so reloading the app (or
// switching between Главная/Карта) doesn't lose track of an active ride.
// All claims and reservations acquire the same driver row lock. Locking only
// the order cannot prevent one driver claiming two different orders at once.
async function lockDriver(tx, driverId) {
  await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId} FOR UPDATE`;
}

function safePrivateOffer(order) {
  return {
    ...orderPayload(Object.fromEntries(Object.keys(AVAILABLE_ORDER_SELECT).map(key => [key, order[key]]))),
    privateOfferRemainingMs: order.privateOfferExpiresAt ? Math.max(0, order.privateOfferExpiresAt.getTime() - Date.now()) : 0
  };
}

// Caller holds the driver row lock, and the order lock for existing work.
async function assertPrivateOfferDriver(tx, driverId, priceEstimated) {
  const driver = await tx.driver.findUnique({ where: { id: driverId }, include: { user: true } });
  if (!driver || driver.status !== 'APPROVED' || driver.user.status === 'BLOCKED') throw ApiError.conflict('Водитель недоступен');
  assertOrderEligibility(driver);
  if (!driver.isAvailable || await tx.order.findFirst({ where: { OR: [
    { driverId, status: { in: ACTIVE_DRIVER_ORDER_STATUSES } },
    { privateOfferDriverId: driverId, status: 'NEW' }
  ] } })) throw ApiError.conflict('У водителя уже есть заказ или предложение');
  const balance = await lockedBalance(tx, driver.userId);
  const price = D(priceEstimated);
  if (!balance.amount.greaterThan(0) || balance.amount.lessThan(price)) throw ApiError.conflict('У водителя недостаточно средств для этого заказа');
  return driver;
}

// Swept on every queue/offer action and once a second while the server runs.
// The persisted deadline, rather than a process timer, decides validity.
async function expirePrivateOffers() {
  const now = new Date();
  const expired = await prisma.order.findMany({ where: { status: 'NEW', OR: [
    { privateOfferExpiresAt: { lte: now } },
    { privateOfferDriverId: null, privateOfferStoppedAt: null, publicReleasedGloballyAt: null, publicRegionOnlyUntil: { lte: now } }
  ] }, include: { district: true } });
  for (const order of expired) {
    // Legacy public rows are already globally claimable, regardless of the
    // historical private fallback flag. Only a real private offer can stop.
    const releasePublicly = !order.privateOfferExpiresAt || order.broadcastAfterPrivateExpiry;
    const data = { privateOfferDriverId: null, privateOfferExpiresAt: null, publicRegionOnlyUntil: null,
      privateOfferStoppedAt: releasePublicly ? null : now,
      publicReleasedGloballyAt: releasePublicly ? now : null };
    const changed = await prisma.$transaction(async tx => {
      const result = await tx.order.updateMany({ where: { id: order.id, status: 'NEW', privateOfferStoppedAt: order.privateOfferStoppedAt,
        privateOfferDriverId: order.privateOfferDriverId,
        ...(order.privateOfferExpiresAt ? { privateOfferExpiresAt: { equals: order.privateOfferExpiresAt, lte: now } } : { publicRegionOnlyUntil: { equals: order.publicRegionOnlyUntil, lte: now } })
      }, data });
      if (result.count) await notifications.invalidateOrder(tx, order.id);
      return result;
    });
    if (changed.count) {
      notifications.wake();
      await publishPrivateRelease({ ...order, ...data, privateOfferDriverId: order.privateOfferDriverId, privateOfferExpiresAt: order.privateOfferExpiresAt }, releasePublicly ? 'global' : 'none');
    }
  }
}

// Queue invalidation is separate from the region-only incoming popup.
async function publishPrivateRelease(order, audience = 'global') {
  await refreshOrderRecipients();
  safeEmit(io => {
    if (order.privateOfferDriverId) io.to(rooms.driver(order.privateOfferDriverId)).emit('order:private-offer-ended', invalidation(order));
    if (audience === 'global') io.to(rooms.publicOrders()).emit('order:available', { ...invalidation(order), districtId: order.districtId });
    io.to(rooms.admins()).emit('order:updated', { ...order, privateOfferDriverId: null, privateOfferExpiresAt: null });
  });
  await districtsService.broadcastDistrictStats();
}

async function getPrivateOffer(driver) {
  await expirePrivateOffers();
  // Offline/GPS expiry must not expose any new work, even via recovery.
  assertOrderEligibility(driver);
  const offer = await prisma.order.findFirst({ where: { status: 'NEW', privateOfferDriverId: driver.id, privateOfferStoppedAt: null, privateOfferExpiresAt: { gt: new Date() } }, select: AVAILABLE_ORDER_SELECT });
  return offer ? safePrivateOffer(offer) : null;
}

async function offerPrivately(orderId, driverId, broadcastAfterPrivateExpiry = true) {
  let removedOffer;
  await expirePrivateOffers();
  const order = await prisma.$transaction(async tx => {
    await lockDriver(tx, driverId);
    const existing = await lockOrder(tx, orderId);
    removedOffer = invalidation(existing);
    const driver = await assertPrivateOfferDriver(tx, driverId, existing.priceEstimated);
    assertOrderEligibility(driver);
    const changed = await tx.order.updateMany({ where: { id: orderId, status: 'NEW', driverId: null, privateOfferDriverId: null }, data: { offerAttemptId: randomUUID(), offerAttemptKind: 'private', privateOfferDriverId: driverId, privateOfferExpiresAt: new Date(Date.now() + 20_000), privateOfferStoppedAt: null, publicRegionOnlyUntil: null, publicReleasedGloballyAt: null, broadcastAfterPrivateExpiry } });
    if (!changed.count) throw ApiError.conflict('Заказ уже принят или предложен другому водителю');
    await notifications.invalidateOrder(tx, orderId);
    const updated = await tx.order.findUnique({ where: { id: orderId }, include: { district: true } });
    if (updated) await notifications.enqueueOrder(tx, updated);
    return updated;
  });
  notifications.wake();
  safeEmit(io => {
    io.to(rooms.driver(driverId)).emit('order:private-offer', safePrivateOffer(order));
    io.to(rooms.drivers()).except(rooms.driver(driverId)).emit('order:taken', removedOffer);
    io.to(rooms.admins()).emit('order:updated', orderPayload(order));
  });
  await districtsService.broadcastDistrictStats();
  return orderPayload(order);
}

async function declinePrivateOffer(orderId, driver, privateOfferExpiresAt) {
  await expirePrivateOffers();
  const order = await prisma.$transaction(async tx => {
    await lockDeviceSession(tx, driver);
    await lockDriver(tx, driver.id);
    assertShiftControl(await tx.driver.findUniqueOrThrow({ where: { id: driver.id } }), driver.sessionDeviceId);
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { district: true } });
    if (!order || order.privateOfferDriverId !== driver.id || order.privateOfferExpiresAt?.toISOString() !== privateOfferExpiresAt) throw ApiError.conflict('Предложение больше недоступно');
    const changed = await tx.order.updateMany({ where: { id: orderId, status: 'NEW', privateOfferDriverId: driver.id, privateOfferStoppedAt: null, privateOfferExpiresAt: { equals: new Date(privateOfferExpiresAt), gt: new Date() } }, data: { privateOfferDriverId: null, privateOfferStoppedAt: new Date() } });
    if (!changed.count) throw ApiError.conflict('Предложение больше недоступно');
    await notifications.invalidateOrder(tx, orderId);
    return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { district: true } });
  });
  // Decline frees the driver but does not shorten the order's exclusive deadline.
  // The expiry sweep applies the dispatcher's public fallback setting.
  safeEmit(io => {
    io.to(rooms.driver(driver.id)).emit('order:private-offer-ended', invalidation(order));
    io.to(rooms.admins()).emit('order:updated', orderPayload(order));
  });
  await districtsService.broadcastDistrictStats();
  return { orderId };
}

async function getCurrent(driver) {
  return orderPayload(await prisma.order.findFirst({
    where: { driverId: driver.id, status: { in: ACTIVE_DRIVER_ORDER_STATUSES } },
    include: { district: true }
  }));
}

// Mutations lock driver then order before rechecking committed state.
async function lockOrder(tx, orderId) {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id: orderId } });
  if (!order) throw ApiError.notFound('Заказ не найден');
  return orderPayload(order);
}

async function accept(orderId, driver, etaMinutes, privateOfferExpiresAt) {
  assertOrderEligibility(driver);
  if (!(await hasPositiveBalance(driver.userId))) {
    throw ApiError.forbidden('Пополните баланс, чтобы принимать заказы');
  }

  await expirePrivateOffers();
  const order = await prisma.$transaction(async (tx) => {
    await lockDeviceSession(tx, driver);
    await lockDriver(tx, driver.id);
    assertShiftControl(await tx.driver.findUniqueOrThrow({ where: { id: driver.id } }), driver.sessionDeviceId);
    await lockOrder(tx, orderId);
    const currentDriver = await tx.driver.findUnique({ where: { id: driver.id } });
    if (!currentDriver) throw ApiError.notFound('Профиль водителя не найден');
    assertOrderEligibility(currentDriver);
    const balance = await lockedBalance(tx, currentDriver.userId);
    if (!balance.amount.greaterThan(0)) {
      throw ApiError.forbidden('Пополните баланс, чтобы принимать заказы');
    }
    if (!currentDriver.isAvailable) throw ApiError.conflict('Водитель сейчас недоступен');
    if (currentDriver.status !== 'APPROVED') throw ApiError.forbidden('Водитель недоступен');
    const pending = await tx.order.findFirst({ where: { privateOfferDriverId: driver.id, status: 'NEW', privateOfferExpiresAt: { gt: new Date() } } });
    if (pending && pending.id !== orderId) throw ApiError.conflict('Сначала ответьте на персональное предложение');
    // A driver can only have one order in progress at a time - this used to
    // be implicitly true because the only way to accept was the "Новый
    // заказ" popup (order.js#applyNewOrder never shows it while an order is
    // already active), but DistrictOrdersSheet.vue lets a driver browse and
    // accept any open order directly, bypassing that popup-only gate
    // entirely. Checked inside the same transaction as the updateMany below
    // while the driver row lock excludes concurrent claims.
    const existingActive = await tx.order.findFirst({
      where: { driverId: driver.id, status: { in: ACTIVE_DRIVER_ORDER_STATUSES } }
    });
    if (existingActive) {
      throw ApiError.conflict('У вас уже есть активный заказ');
    }

    // Public visibility is global; private delivery remains exclusive until expiry.
    const updateResult = await tx.order.updateMany({
      where: { id: orderId, driverId: null, status: 'NEW', privateOfferStoppedAt: null, ...(privateOfferExpiresAt ? { privateOfferDriverId: driver.id, privateOfferExpiresAt: { equals: new Date(privateOfferExpiresAt), gt: new Date() } } : { privateOfferDriverId: null }) },
      data: { driverId: driver.id, status: 'ACCEPTED', acceptedAt: new Date(), etaMinutes, privateOfferDriverId: null, privateOfferExpiresAt: null }
    });

    if (updateResult.count === 0) {
      const existing = await tx.order.findUnique({ where: { id: orderId } });
      if (!existing) throw ApiError.notFound('Заказ не найден');
      throw ApiError.conflict('Заказ уже принят другим водителем или недоступен');
    }

    await tx.driver.update({ where: { id: driver.id }, data: { isAvailable: false } });

    const acceptedOrder = await tx.order.findUnique({ where: { id: orderId }, include: { district: true } });
    await notifications.invalidateOrder(tx, orderId);

    const wallet = await debitOrderQuoteOnAcceptance(tx, acceptedOrder, driver.id, driver.userId);
    return { order: orderPayload(acceptedOrder), wallet };

  });

  safeEmit((io) => {
    io.to(rooms.driver(driver.id)).emit('order:private-offer-ended', invalidation(order.order));
    io.to(rooms.admins()).emit('order:accepted', order.order);
    io.to(rooms.order(order.order.id)).emit('order:accepted', order.order);
    io.to(rooms.drivers()).emit('order:taken', invalidation(order.order));
    io.to(rooms.driver(driver.id)).to(rooms.admins()).emit('balance:updated', {
      driverId: driver.id, ...order.wallet, reason: 'PAYMENT', orderId: order.order.id
    });
  });

  await districtsService.broadcastDistrictStats();

  return order.order;
}

function assertOwnedByDriver(order, driver) {
  if (!order) throw ApiError.notFound('Заказ не найден');
  if (order.driverId !== driver.id) throw ApiError.forbidden('Этот заказ не назначен вам');
}

// "Ожидаю" - pressed the moment the driver physically arrives at point А.
// Starts the wait clock; the fee for it is only computed once the trip
// actually starts (see startTrip), so a driver watching their own screen
// sees the free-then-ticking countdown computed live from `arrivedAt`
// without the server needing to push anything every second.
async function markWaiting(orderId, driver) {
  const updated = await prisma.$transaction(async (tx) => {
    await lockDeviceSession(tx, driver);
    await lockDriver(tx, driver.id);
    assertShiftControl(await tx.driver.findUniqueOrThrow({ where: { id: driver.id } }), driver.sessionDeviceId);
    const order = await lockOrder(tx, orderId);
    assertOwnedByDriver(order, driver);
    if (order.status !== 'ACCEPTED') {
      throw ApiError.conflict('Невозможно начать ожидание в текущем статусе заказа', { status: order.status });
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: 'WAITING', arrivedAt: new Date() }
    });
    return orderPayload(updated);
  });

  safeEmit((io) => {
    io.to(rooms.admins()).emit('order:waiting', updated);
    io.to(rooms.order(updated.id)).emit('order:waiting', updated);
  });

  return updated;
}

// "Начать поездку" - locks in the wait fee (frozen at this instant, exactly
// as many WAIT_INCREMENT_MINUTES blocks as elapsed) and switches billing
// over to the per-km tariff for the rest of the ride.
async function startTrip(orderId, driver) {
  const updated = await prisma.$transaction(async (tx) => {
    await lockDeviceSession(tx, driver);
    await lockDriver(tx, driver.id);
    assertShiftControl(await tx.driver.findUniqueOrThrow({ where: { id: driver.id } }), driver.sessionDeviceId);
    const order = await lockOrder(tx, orderId);
    assertOwnedByDriver(order, driver);
    if (order.status !== 'WAITING') {
      throw ApiError.conflict('Невозможно начать поездку в текущем статусе заказа', { status: order.status });
    }

    const startedAt = new Date();
    const waitFee = calculateWaitFee(order.arrivedAt, startedAt);

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: 'STARTED', startedAt, waitFee }
    });
    return { order: orderPayload(updated), wallet: null };
  });

  safeEmit((io) => {
    io.to(rooms.admins()).emit('order:started', updated.order);
    io.to(rooms.order(updated.order.id)).emit('order:started', updated.order);
  });
  return updated.order;
}

// Completion preserves the captured quote and never charges again.
async function complete(orderId, driver) {
  const updatedOrder = await prisma.$transaction(async (tx) => {
    await lockDeviceSession(tx, driver);
    await lockDriver(tx, driver.id);
    assertShiftControl(await tx.driver.findUniqueOrThrow({ where: { id: driver.id } }), driver.sessionDeviceId);
    const order = await lockOrder(tx, orderId);
    assertOwnedByDriver(order, driver);
    if (order.status !== 'STARTED') {
      throw ApiError.conflict('Невозможно завершить поездку в текущем статусе заказа', { status: order.status });
    }
    const completedAt = new Date();
    const distanceKm = await calculateDistanceKm(driver.id, order.startedAt, completedAt, tx);
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: 'COMPLETED', completedAt, distanceKm: D(distanceKm), priceFinal: await acceptedPrice(tx, order) }
    });
    await tx.driver.update({ where: { id: driver.id }, data: { isAvailable: true } });
    await tx.orderAssignment.updateMany({ where: { orderId, offerAttemptId: order.offerAttemptId }, data: { endedAt: completedAt, endAction: 'COMPLETED' } });
    return orderPayload(updated);
  });

  safeEmit((io) => {
    io.to(rooms.admins()).emit('order:completed', updatedOrder);
    io.to(rooms.order(updatedOrder.id)).emit('order:completed', updatedOrder);
  });

  await districtsService.broadcastDistrictStats();

  return updatedOrder;
}

// Old driver clients must fail before any assignment or financial mutation.
async function cancel() {
  throw ApiError.forbidden('Отменить заказ может только диспетчер');
}

// Phone dispatch always uses the selected region for order offers. Optional
// pickup coordinates refine the location without overriding that selection.
async function createOrder(data) {
  const district = await prisma.district.findUnique({ where: { id: data.districtId } });
  if (!district || !district.isActive) throw ApiError.badRequest('Указанный район не найден или неактивен');
  const districtId = district.id;

  // pickupLat/pickupLng are non-nullable columns, but the dispatcher isn't
  // required to click a precise point on the map - picking a district is
  // enough (see orders.validation.js#createOrderSchema). When they didn't,
  // the district centre is a storage fallback, not a precise customer pickup.
  // The driver calls the customer after accepting to agree on pickup details.
  const pickupLat = data.pickupLat !== undefined ? data.pickupLat : district && Number(district.centerLat);
  const pickupLng = data.pickupLng !== undefined ? data.pickupLng : district && Number(district.centerLng);
  if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
    throw ApiError.badRequest('Не удалось определить точку «Откуда»: укажите её на карте или выберите район');
  }

  await expirePrivateOffers();
  const { privateOfferDriverId, ...publicData } = data;
  const order = await prisma.$transaction(async tx => {
    if (privateOfferDriverId) {
      await lockDriver(tx, privateOfferDriverId);
      await assertPrivateOfferDriver(tx, privateOfferDriverId, publicData.priceEstimated);
    }
    const created = await tx.order.create({
      data: { ...publicData, pickupLat, pickupLng, districtId, status: 'NEW', broadcastAfterPrivateExpiry: privateOfferDriverId ? publicData.broadcastAfterPrivateExpiry : true, publicRegionOnlyUntil: privateOfferDriverId ? null : new Date(Date.now() + 20_000), publicReleasedGloballyAt: privateOfferDriverId ? null : new Date(), ...(privateOfferDriverId ? { offerAttemptKind: 'private', privateOfferDriverId, privateOfferExpiresAt: new Date(Date.now() + 20_000) } : {}) },
      include: { district: true }
    });
    await notifications.enqueueOrder(tx, created);
    return orderPayload(created);
  });
  notifications.wake();

  // Same privacy rule as listAvailable: a driver who hasn't accepted yet
  // must not see the client's phone number, so the district broadcast gets
  // a stripped copy - only the admin's own room (and the HTTP response to
  // the admin who dispatched it) gets the full order.
  const { clientPhone, ...orderWithoutPhone } = order;
  void clientPhone;

  try {
    await refreshOrderRecipients();
  } catch (err) {
    logger.warn({ err }, 'Order saved but socket eligibility check failed');
    await districtsService.broadcastDistrictStats();
    return order;
  }
  const deliverable = await prisma.order.findUnique({ where: { id: order.id } });
  safeEmit((io) => {
    if (!deliverable || deliverable.offerAttemptId !== order.offerAttemptId || deliverable.status !== 'NEW' || deliverable.driverId || deliverable.privateOfferStoppedAt || deliverable.privateOfferDriverId !== order.privateOfferDriverId || deliverable.privateOfferExpiresAt?.getTime() !== order.privateOfferExpiresAt?.getTime()) return;
    if (order.privateOfferDriverId) io.to(rooms.driver(order.privateOfferDriverId)).emit('order:private-offer', safePrivateOffer(order));
    else {
      io.to(rooms.publicOrders()).emit('order:available', { ...invalidation(order), districtId: order.districtId });
      if (order.districtId) io.to(rooms.district(order.districtId)).emit('order:new', { ...orderWithoutPhone, publicOfferRemainingMs: Math.max(0, order.publicRegionOnlyUntil.getTime() - Date.now()) });
    }
    io.to(rooms.admins()).emit('order:new', order);
  });

  await districtsService.broadcastDistrictStats();

  return orderPayload(order);
}

// Cancellation and the chosen financial outcome commit with driver release.
async function adminCancel(orderId, outcome, actorId) {
  // Read only to choose the lock order. Revalidate after locking: a concurrent
  // claim of a NEW order must not be cancelled using its stale unassigned state.
  const observed = await prisma.order.findUnique({ where: { id: orderId } });
  if (!observed) throw ApiError.notFound('Заказ не найден');
  const result = await prisma.$transaction(async (tx) => {
    if (observed.driverId) await lockDriver(tx, observed.driverId);
    const order = await lockOrder(tx, orderId);
    if (order.driverId !== observed.driverId) {
      throw ApiError.conflict('Заказ изменился. Повторите отмену');
    }
    if (!['NEW', 'ACCEPTED', 'WAITING', 'STARTED'].includes(order.status)) {
      throw ApiError.conflict('Невозможно отменить заказ в текущем статусе', { status: order.status });
    }
    // Only an unassigned NEW order cancels before acceptance. Any other mix of
    // status and driver cannot prove its original debit, so nothing changes.
    const assigned = order.status !== 'NEW';
    if (assigned !== Boolean(order.driverId)) {
      throw ApiError.conflict('Назначение заказа требует сверки диспетчером', { code: 'LEGACY_FUNDING_AMBIGUOUS' });
    }
    if (assigned && !['WITH_REFUND', 'WITHOUT_REFUND'].includes(outcome)) {
      throw ApiError.badRequest('Выберите отмену с возвратом или без возврата');
    }
    let released = null;
    if (assigned) {
      const driver = await tx.driver.update({ where: { id: order.driverId }, data: { isAvailable: true } });
      released = await cancelOrderFunding(tx, order, driver.userId, outcome);
    }
    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: actorId,
        cancellationOutcome: assigned ? released.outcome : 'BEFORE_ACCEPTANCE',
        cancellationRefundAmount: released?.refund ?? D(0), cancellationReviewRequired: false
      }
    });
    await notifications.invalidateOrder(tx, orderId);
    await tx.orderResolutionAudit.create({ data: { orderId, actorId, action: 'ADMIN_CANCELLED', offerAttemptId: order.offerAttemptId, driverId: order.driverId, reason: '', createdAt: updated.cancelledAt } });
    return { order: orderPayload(updated), released, wasUnaccepted: !assigned };
  });
  const order = result.order;

  safeEmit((io) => {
    if (result.order.privateOfferDriverId) io.to(rooms.driver(result.order.privateOfferDriverId)).emit('order:private-offer-ended', invalidation(result.order));
    io.to(rooms.admins()).emit('order:cancelled', result.order);
    io.to(rooms.order(result.order.id)).emit('order:cancelled', result.order);
    if (order.driverId) {
      io.to(rooms.driver(order.driverId)).emit('order:cancelled', result.order);
      if (result.released?.changed) io.to(rooms.driver(order.driverId)).to(rooms.admins()).emit('balance:updated', { driverId: order.driverId, ...result.released.wallet, reason: result.released.reason, orderId });
    }
    // The order was still just broadcast to every driver in the district as
    // an unaccepted "Новый заказ" popup (see createOrder) - order:taken is
    // exactly the existing signal driver/order.js's applyOrderTaken already
    // uses to close that popup, so this reuses it rather than needing a new
    // frontend event handler for "admin pulled it before anyone answered".
    if (result.wasUnaccepted) {
      io.to(rooms.drivers()).emit('order:taken', invalidation(result.order));
    }
  });

  await districtsService.broadcastDistrictStats();

  return result.order;
}

// A started trip is never completed by a clock. If the driver loses the app
// or forgets the final action, a dispatcher can explicitly resolve it after
// verifying the ride. The required reason is persisted as an attributable
// audit event; the original assignment and charge stay intact.
async function forceResolveStarted(orderId, actorId, reason) {
  const observed = await prisma.order.findUnique({ where: { id: orderId }, select: { driverId: true } });
  if (!observed) throw ApiError.notFound('Заказ не найден');
  const completedAt = new Date();
  const result = await prisma.$transaction(async (tx) => {
    if (observed.driverId) await lockDriver(tx, observed.driverId);
    const order = await lockOrder(tx, orderId);
    if (order.driverId !== observed.driverId) throw ApiError.conflict('Заказ изменился. Повторите завершение');
    const funding = await tx.orderAssignment.findUnique({ where: { orderId_offerAttemptId: { orderId, offerAttemptId: order.offerAttemptId } } });
    if (funding?.fundingState === 'HELD') throw ApiError.conflict('Средства поездки ещё не списаны');
    if (order.status !== 'STARTED') {
      throw ApiError.conflict('Принудительно завершить можно только начатую поездку', { status: order.status });
    }
    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'COMPLETED',
        completedAt,
        priceFinal: order.priceFinal ?? await acceptedPrice(tx, order)
      },
      include: { driver: { include: { user: { select: { fullName: true, phone: true, archivedPhone: true } } } }, district: true }
    });
    if (order.driverId) {
      await tx.driver.update({ where: { id: order.driverId }, data: { isAvailable: true } });
    }
    await tx.orderAssignment.updateMany({ where: { orderId, offerAttemptId: order.offerAttemptId }, data: { endedAt: completedAt, endAction: 'FORCE_COMPLETED' } });
    await tx.orderResolutionAudit.create({
      data: { orderId, actorId, action: 'FORCE_COMPLETED', offerAttemptId: order.offerAttemptId, driverId: order.driverId, reason }
    });
    return orderPayload({ ...updated, driver: require('../driver/public-profile').publicDriverProfile(updated.driver) });
  });

  safeEmit((io) => {
    io.to(rooms.admins()).emit('order:completed', { ...result, forced: true, resolutionReason: reason });
    io.to(rooms.order(result.id)).emit('order:completed', { ...result, forced: true });
    if (result.driverId) io.to(rooms.driver(result.driverId)).emit('order:completed', { ...result, forced: true });
  });
  await districtsService.broadcastDistrictStats();
  return result;
}

module.exports = {
  listAvailable,
  getPrivateOffer,
  offerPrivately,
  declinePrivateOffer,
  expirePrivateOffers,
  getCurrent,
  accept,
  markWaiting,
  startTrip,
  complete,
  cancel,
  adminCancel,
  forceResolveStarted,
  NEEDS_COMPLETION_AFTER_MS,
  createOrder,
  // exported for tests/tooling - pure functions, no I/O
  calculateWaitFee,
  WAIT_FREE_MINUTES,
  WAIT_INCREMENT_MINUTES,
  WAIT_INCREMENT_FEE,
  DISTANCE_RATE_PER_KM
};
