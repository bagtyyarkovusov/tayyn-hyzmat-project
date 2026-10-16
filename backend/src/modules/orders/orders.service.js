const { Prisma } = require('@prisma/client');
const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');
const { getIO } = require('../../lib/socket');
const rooms = require('../../sockets/rooms');
const logger = require('../../config/logger');
const districtsService = require('../districts/districts.service');
const { haversineDistanceKm } = require('../../utils/geo');
const { recordOrderCharge } = require('./order-charge');
const { assertOrderEligibility } = require('../driver/gps-eligibility');
const { refreshOrderRecipients } = require('../../sockets/roomSync');

const D = (value) => new Prisma.Decimal(value ?? 0);

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
async function calculateDistanceKm(driverId, fromDate, toDate) {
  const points = await prisma.driverLocation.findMany({
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
  privateOfferExpiresAt: true
};

// districtId lets a driver look at any of the 9 district cards, not just
// the one they're physically in (tapping a district square in the app -
// see DistrictCard.vue) - defaults to the driver's own district when
// omitted, same behavior as before this parameter existed. This is a
// read-only view: accept() below independently enforces that a driver can
// only actually take an order from their OWN district, regardless of what
// this returns, so viewing another district's queue never grants the
// ability to act on it.
async function listAvailable(driver, districtId) {
  assertOrderEligibility(driver);
  await expirePrivateOffers();
  if (!(await hasPositiveBalance(driver.userId))) {
    return [];
  }

  const targetDistrictId = districtId || driver.districtId;
  return prisma.order.findMany({
    where: {
      driverId: null,
      status: 'NEW',
      privateOfferDriverId: null,
      ...(targetDistrictId ? { districtId: targetDistrictId } : {})
    },
    orderBy: { createdAt: 'asc' },
    select: AVAILABLE_ORDER_SELECT
  });
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
    ...Object.fromEntries(Object.keys(AVAILABLE_ORDER_SELECT).map(key => [key, order[key]])),
    privateOfferRemainingMs: order.privateOfferExpiresAt ? Math.max(0, order.privateOfferExpiresAt.getTime() - Date.now()) : 0
  };
}

async function assertPrivateOfferDriver(tx, driverId) {
  await lockDriver(tx, driverId);
  const driver = await tx.driver.findUnique({ where: { id: driverId }, include: { user: true } });
  if (!driver || driver.status !== 'APPROVED' || driver.user.status === 'BLOCKED') throw ApiError.conflict('Водитель недоступен');
  assertOrderEligibility(driver);
  if (!driver.isAvailable || await tx.order.findFirst({ where: { OR: [
    { driverId, status: { in: ACTIVE_DRIVER_ORDER_STATUSES } },
    { privateOfferDriverId: driverId, status: 'NEW' }
  ] } })) throw ApiError.conflict('У водителя уже есть заказ или предложение');
  const balance = await tx.balance.findUnique({ where: { userId: driver.userId } });
  if (!balance || !balance.amount.greaterThan(0)) throw ApiError.conflict('У водителя недостаточно средств');
}

// Swept on every queue/offer action and once a second while the server runs.
// The persisted deadline, rather than a process timer, decides validity.
async function expirePrivateOffers() {
  const expired = await prisma.order.findMany({ where: { status: 'NEW', privateOfferDriverId: { not: null }, privateOfferExpiresAt: { lte: new Date() } }, include: { district: true } });
  for (const order of expired) {
    const changed = await prisma.order.updateMany({ where: { id: order.id, status: 'NEW', privateOfferDriverId: order.privateOfferDriverId, privateOfferExpiresAt: { lte: new Date() } }, data: { privateOfferDriverId: null, privateOfferExpiresAt: null } });
    if (changed.count) await publishPrivateRelease(order);
  }
}

async function publishPrivateRelease(order) {
  await refreshOrderRecipients();
  safeEmit(io => {
    io.to(rooms.driver(order.privateOfferDriverId)).emit('order:private-offer-ended', { orderId: order.id, privateOfferExpiresAt: order.privateOfferExpiresAt });
    if (order.districtId) io.to(rooms.district(order.districtId)).emit('order:new', { ...safePrivateOffer(order), privateOfferExpiresAt: null });
    io.to(rooms.admins()).emit('order:updated', { ...order, privateOfferDriverId: null, privateOfferExpiresAt: null });
  });
  await districtsService.broadcastDistrictStats();
}

async function getPrivateOffer(driver) {
  await expirePrivateOffers();
  // Offline/GPS expiry must not expose any new work, even via recovery.
  assertOrderEligibility(driver);
  const offer = await prisma.order.findFirst({ where: { status: 'NEW', privateOfferDriverId: driver.id, privateOfferExpiresAt: { gt: new Date() } }, select: AVAILABLE_ORDER_SELECT });
  return offer ? safePrivateOffer(offer) : null;
}

async function offerPrivately(orderId, driverId) {
  await expirePrivateOffers();
  const order = await prisma.$transaction(async tx => {
    await assertPrivateOfferDriver(tx, driverId);
    const changed = await tx.order.updateMany({ where: { id: orderId, status: 'NEW', driverId: null, privateOfferDriverId: null }, data: { privateOfferDriverId: driverId, privateOfferExpiresAt: new Date(Date.now() + 20_000) } });
    if (!changed.count) throw ApiError.conflict('Заказ уже принят или предложен другому водителю');
    return tx.order.findUnique({ where: { id: orderId }, include: { district: true } });
  });
  safeEmit(io => {
    io.to(rooms.driver(driverId)).emit('order:private-offer', safePrivateOffer(order));
    if (order.districtId) io.to(rooms.district(order.districtId)).except(rooms.driver(driverId)).emit('order:taken', { orderId });
    io.to(rooms.admins()).emit('order:updated', order);
  });
  await districtsService.broadcastDistrictStats();
  return order;
}

async function declinePrivateOffer(orderId, driver, privateOfferExpiresAt) {
  await expirePrivateOffers();
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { district: true } });
  if (!order || order.privateOfferDriverId !== driver.id || order.privateOfferExpiresAt?.toISOString() !== privateOfferExpiresAt) throw ApiError.conflict('Предложение больше недоступно');
  const changed = await prisma.order.updateMany({ where: { id: orderId, status: 'NEW', privateOfferDriverId: driver.id, privateOfferExpiresAt: { equals: new Date(privateOfferExpiresAt), gt: new Date() } }, data: { privateOfferDriverId: null, privateOfferExpiresAt: null } });
  if (!changed.count) throw ApiError.conflict('Предложение больше недоступно');
  await publishPrivateRelease(order);
  return { orderId };
}

async function getCurrent(driver) {
  return prisma.order.findFirst({
    where: { driverId: driver.id, status: { in: ACTIVE_DRIVER_ORDER_STATUSES } },
    include: { district: true }
  });
}

async function accept(orderId, driver, etaMinutes, privateOfferExpiresAt) {
  assertOrderEligibility(driver);
  if (!(await hasPositiveBalance(driver.userId))) {
    throw ApiError.forbidden('Пополните баланс, чтобы принимать заказы');
  }

  await expirePrivateOffers();
  const order = await prisma.$transaction(async (tx) => {
    await lockDriver(tx, driver.id);
    const currentDriver = await tx.driver.findUnique({ where: { id: driver.id } });
    if (!currentDriver) throw ApiError.notFound('Профиль водителя не найден');
    assertOrderEligibility(currentDriver);
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
    // so two concurrent accept calls can't both slip through.
    const existingActive = await tx.order.findFirst({
      where: { driverId: driver.id, status: { in: ACTIVE_DRIVER_ORDER_STATUSES } }
    });
    if (existingActive) {
      throw ApiError.conflict('У вас уже есть активный заказ');
    }

    // Was district-restricted (districtId: driver.districtId in this
    // where clause) - a driver could only accept an order in their own
    // GPS-derived district, per explicit earlier request. Reversed by
    // later explicit request: any driver can now accept any open order in
    // any district, same as DistrictOrdersSheet.vue's "Принять" button
    // being shown for every district, not just the driver's own (see
    // there - isOwnDistrict/canAccept no longer gate it).
    const updateResult = await tx.order.updateMany({
      where: { id: orderId, driverId: null, status: 'NEW', ...(privateOfferExpiresAt ? { privateOfferDriverId: driver.id, privateOfferExpiresAt: { equals: new Date(privateOfferExpiresAt), gt: new Date() } } : { privateOfferDriverId: null }) },
      data: { driverId: driver.id, status: 'ACCEPTED', acceptedAt: new Date(), etaMinutes, privateOfferDriverId: null, privateOfferExpiresAt: null }
    });

    if (updateResult.count === 0) {
      const existing = await tx.order.findUnique({ where: { id: orderId } });
      if (!existing) throw ApiError.notFound('Заказ не найден');
      throw ApiError.conflict('Заказ уже принят другим водителем или недоступен');
    }

    await tx.driver.update({ where: { id: driver.id }, data: { isAvailable: false } });

    const acceptedOrder = await tx.order.findUnique({ where: { id: orderId }, include: { district: true } });

    // The order's quoted price is charged to the driver's balance right
    // here, at accept - not the old model (see complete() below), which
    // deducted a distance-driven commission only once the ride finished.
    // Refunded in full by cancel()/adminCancel() if the order doesn't end
    // up completed (see there for why "was ever charged" == "has a
    // driverId" is the right refund condition).
    const balanceAfter = await recordOrderCharge(tx, acceptedOrder, driver.userId, 'PAYMENT');

    return { order: acceptedOrder, balanceAfter };
  });

  safeEmit((io) => {
    io.to(rooms.driver(driver.id)).emit('order:private-offer-ended', { orderId: order.order.id, privateOfferExpiresAt });
    io.to(rooms.admins()).emit('order:accepted', order.order);
    io.to(rooms.order(order.order.id)).emit('order:accepted', order.order);
    // Tell every other driver watching this district that the order is gone.
    if (order.order.districtId) {
      io.to(rooms.district(order.order.districtId)).emit('order:taken', { orderId: order.order.id });
    }
    if (order.balanceAfter !== null) {
      io.to(rooms.driver(driver.id)).to(rooms.admins()).emit('balance:updated', {
        driverId: driver.id,
        amount: order.balanceAfter,
        reason: 'PAYMENT',
        orderId: order.order.id
      });
    }
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
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  assertOwnedByDriver(order, driver);
  if (order.status !== 'ACCEPTED') {
    throw ApiError.conflict('Невозможно начать ожидание в текущем статусе заказа', { status: order.status });
  }

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: 'WAITING', arrivedAt: new Date() }
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
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  assertOwnedByDriver(order, driver);
  if (order.status !== 'WAITING') {
    throw ApiError.conflict('Невозможно начать поездку в текущем статусе заказа', { status: order.status });
  }

  const startedAt = new Date();
  const waitFee = calculateWaitFee(order.arrivedAt, startedAt);

  const updated = await prisma.order.update({
    where: { id: orderId },
    data: { status: 'STARTED', startedAt, waitFee }
  });

  safeEmit((io) => {
    io.to(rooms.admins()).emit('order:started', updated);
    io.to(rooms.order(updated.id)).emit('order:started', updated);
  });

  return updated;
}

// "Завершить заказ" - money no longer changes hands here. The driver was
// already charged the order's quoted price up front, at accept() - see the
// comment there. distanceKm/waitFee are kept purely as trip metadata (still
// useful for an admin to see how far/long a ride actually was) with no
// effect on the balance any more; priceFinal is set to what was actually
// charged (priceEstimated) rather than a distance-derived number, so it
// doesn't misleadingly suggest a second amount was billed.
async function complete(orderId, driver) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  assertOwnedByDriver(order, driver);
  if (order.status !== 'STARTED') {
    throw ApiError.conflict('Невозможно завершить поездку в текущем статусе заказа', { status: order.status });
  }

  const completedAt = new Date();
  const distanceKm = await calculateDistanceKm(driver.id, order.startedAt, completedAt);

  const [updatedOrder] = await prisma.$transaction([
    prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'COMPLETED',
        completedAt,
        distanceKm: D(distanceKm),
        priceFinal: order.priceEstimated
      }
    }),
    prisma.driver.update({ where: { id: driver.id }, data: { isAvailable: true } })
  ]);

  safeEmit((io) => {
    io.to(rooms.admins()).emit('order:completed', updatedOrder);
    io.to(rooms.order(updatedOrder.id)).emit('order:completed', updatedOrder);
  });

  await districtsService.broadcastDistrictStats();

  return updatedOrder;
}

// ACCEPTED/WAITING: once a trip has STARTED, cancelling would abandon a
// passenger mid-ride, which needs different handling than this endpoint.
//
// A driver who took this order was already charged its price at accept()
// (see there) - cancelling it (whichever side is at fault: passenger
// no-show, driver couldn't make it, etc.) means the ride never happened, so
// that charge is refunded in full here. Shared with adminCancel() below via
// recordOrderCharge.
async function cancel(orderId, driver, reason) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  assertOwnedByDriver(order, driver);
  if (!['ACCEPTED', 'WAITING'].includes(order.status)) {
    throw ApiError.conflict('Невозможно отменить заказ в текущем статусе', { status: order.status });
  }

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason || null }
    });
    await tx.driver.update({ where: { id: driver.id }, data: { isAvailable: true } });
    const balanceAfter = await recordOrderCharge(tx, order, driver.userId, 'REFUND');
    return { order: updated, balanceAfter };
  });

  safeEmit((io) => {
    io.to(rooms.admins()).emit('order:cancelled', result.order);
    io.to(rooms.order(result.order.id)).emit('order:cancelled', result.order);
    if (result.balanceAfter !== null) {
      io.to(rooms.driver(driver.id)).to(rooms.admins()).emit('balance:updated', {
        driverId: driver.id,
        amount: result.balanceAfter,
        reason: 'REFUND',
        orderId: result.order.id
      });
    }
  });

  await districtsService.broadcastDistrictStats();

  return result.order;
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
    if (privateOfferDriverId) await assertPrivateOfferDriver(tx, privateOfferDriverId);
    return tx.order.create({
      data: { ...publicData, pickupLat, pickupLng, districtId, status: 'NEW', ...(privateOfferDriverId ? { privateOfferDriverId, privateOfferExpiresAt: new Date(Date.now() + 20_000) } : {}) },
      include: { district: true }
    });
  });

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
  safeEmit((io) => {
    if (order.privateOfferDriverId) io.to(rooms.driver(order.privateOfferDriverId)).emit('order:private-offer', safePrivateOffer(order));
    else if (order.districtId) io.to(rooms.district(order.districtId)).emit('order:new', orderWithoutPhone);
    io.to(rooms.admins()).emit('order:new', order);
  });

  await districtsService.broadcastDistrictStats();

  return order;
}

// Admin dispatch cancel - unlike the driver's own `cancel` above (which only
// works ACCEPTED/WAITING on that driver's own order, and is reachable at
// POST /orders/cancel behind requireRole('DRIVER')), an admin needs to be
// able to pull any order that hasn't finished yet, whether or not a driver
// has even accepted it. NEW/ACCEPTED/WAITING/STARTED are all cancellable;
// COMPLETED/CANCELLED are terminal and rejected the same way the driver
// endpoint rejects an already-wrong status.
async function adminCancel(orderId, reason) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { driver: true } });
  if (!order) throw ApiError.notFound('Заказ не найден');
  if (['COMPLETED', 'CANCELLED'].includes(order.status)) {
    throw ApiError.conflict('Невозможно отменить заказ в текущем статусе', { status: order.status });
  }

  const wasUnaccepted = order.status === 'NEW';

  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.order.updateMany({
      where: { id: orderId, status: order.status, driverId: order.driverId },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason || null }
    });
    if (!changed.count) throw ApiError.conflict('Заказ изменился, обновите список');
    const updated = await tx.order.findUnique({ where: { id: orderId } });
    let balanceAfter = null;
    if (order.driverId) {
      await tx.driver.update({ where: { id: order.driverId }, data: { isAvailable: true } });
      // Same refund as the driver's own cancel() - an admin pulling an
      // already-accepted order is the same "ride didn't happen" case.
      balanceAfter = await recordOrderCharge(tx, order, order.driver.userId, 'REFUND');
    }
    return { order: updated, balanceAfter };
  });

  safeEmit((io) => {
    if (result.order.privateOfferDriverId) io.to(rooms.driver(result.order.privateOfferDriverId)).emit('order:private-offer-ended', { orderId, privateOfferExpiresAt: result.order.privateOfferExpiresAt });
    io.to(rooms.admins()).emit('order:cancelled', result.order);
    io.to(rooms.order(result.order.id)).emit('order:cancelled', result.order);
    if (order.driverId) {
      io.to(rooms.driver(order.driverId)).emit('order:cancelled', result.order);
      if (result.balanceAfter !== null) {
        io.to(rooms.driver(order.driverId)).to(rooms.admins()).emit('balance:updated', {
          driverId: order.driverId,
          amount: result.balanceAfter,
          reason: 'REFUND',
          orderId: result.order.id
        });
      }
    }
    // The order was still just broadcast to every driver in the district as
    // an unaccepted "Новый заказ" popup (see createOrder) - order:taken is
    // exactly the existing signal driver/order.js's applyOrderTaken already
    // uses to close that popup, so this reuses it rather than needing a new
    // frontend event handler for "admin pulled it before anyone answered".
    if (wasUnaccepted && order.districtId) {
      io.to(rooms.district(order.districtId)).emit('order:taken', { orderId: result.order.id });
    }
  });

  await districtsService.broadcastDistrictStats();

  return result.order;
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
  createOrder,
  // exported for tests/tooling - pure functions, no I/O
  calculateWaitFee,
  WAIT_FREE_MINUTES,
  WAIT_INCREMENT_MINUTES,
  WAIT_INCREMENT_FEE,
  DISTANCE_RATE_PER_KM
};
