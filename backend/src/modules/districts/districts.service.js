const prisma = require('../../lib/prisma');
const { getIO } = require('../../lib/socket');
const rooms = require('../../sockets/rooms');
const logger = require('../../config/logger');
const { findNearestDistrict, findDistrictByBoundary } = require('../../utils/geo');
const { refreshOrderRecipients } = require('../../sockets/roomSync');
const { onlineDriverWhere } = require('../driver/gps-eligibility');

// "Активные заказы" - anything still in the pipeline (not finished, not
// cancelled). "Свободные водители" - online, available, approved AND with a
// positive balance, since a driver at zero balance cannot receive orders
// anyway (see orders.service.js) and would be a misleading "free" count.
const ACTIVE_ORDER_STATUSES_EXCLUDED = ['COMPLETED', 'CANCELLED'];

async function listDistrictsWithStats() {
  const districts = await prisma.district.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' }
  });

  const onlineWhere = onlineDriverWhere();
  const [orderCounts, publicAvailableCounts, candidateFreeDrivers, onlineCounts] = await Promise.all([
    prisma.order.groupBy({
      by: ['districtId'],
      where: { districtId: { not: null }, status: { notIn: ACTIVE_ORDER_STATUSES_EXCLUDED } },
      _count: { _all: true }
    }),
    // Public availability is distinct from dispatcher unfinished work. A
    // common snapshot must never reveal private reservations or stopped offers.
    prisma.order.groupBy({
      by: ['districtId'],
      where: { districtId: { not: null }, status: 'NEW', driverId: null,
        privateOfferDriverId: null, privateOfferStoppedAt: null },
      _count: { _all: true }
    }),
    // Balance is a relation, not a scalar on Driver, so it's filtered and
    // tallied here in JS rather than in a groupBy - simple and unambiguous
    // for the driver counts a single city instance actually has.
    prisma.driver.findMany({
      where: { ...onlineWhere, districtId: { not: null }, isAvailable: true, orders: { none: { status: { in: ['ACCEPTED', 'WAITING', 'STARTED'] } } } },
      select: { districtId: true, user: { select: { balance: { select: { amount: true } } } } }
    }),
    prisma.driver.groupBy({
      by: ['districtId'],
      where: { ...onlineWhere, districtId: { not: null } },
      _count: { _all: true }
    })
  ]);

  const orderCountByDistrict = new Map(orderCounts.map((row) => [row.districtId, row._count._all]));

  const publicAvailableByDistrict = new Map(publicAvailableCounts.map(row => [row.districtId, row._count._all]));
  const onlineCountByDistrict = new Map(onlineCounts.map(row => [row.districtId, row._count._all]));
  const freeDriverCountByDistrict = new Map();
  for (const driver of candidateFreeDrivers) {
    const hasPositiveBalance = driver.user.balance && Number(driver.user.balance.amount) > 0;
    if (!hasPositiveBalance) continue;
    freeDriverCountByDistrict.set(driver.districtId, (freeDriverCountByDistrict.get(driver.districtId) || 0) + 1);
  }

  return districts.map((district) => ({
    id: district.id,
    name: district.name,
    // centerLat/centerLng were missing here, which is what silently broke
    // CreateOrderModal.vue's "pick a district instead of clicking the map"
    // path: it read them off this response, got undefined, and sent NaN.
    // Also what the address auto-fill reverse-geocodes when no map point
    // was clicked. Not sensitive - a dispatch-zone centre, and drivers
    // already see every district by name here.
    centerLat: Number(district.centerLat),
    centerLng: Number(district.centerLng),
    boundary: district.boundary,
    activeOrders: orderCountByDistrict.get(district.id) || 0,
    publicAvailableOrders: publicAvailableByDistrict.get(district.id) || 0,
    freeDrivers: freeDriverCountByDistrict.get(district.id) || 0,
    onlineDrivers: onlineCountByDistrict.get(district.id) || 0
  }));
}

// Driver GPS uses saved dispatch polygons only. A nearby center is not
// evidence that a position belongs to that region.
async function findDistrictForGpsPoint(lat, lng) {
  const districts = await prisma.district.findMany({
    where: { isActive: true },
    select: { id: true, centerLat: true, centerLng: true, boundary: true }
  });
  return findDistrictByBoundary(districts, { lat, lng });
}

// Retain the inherited nearest-center interface for callers that explicitly
// request that fallback. Driver location must use findDistrictForGpsPoint.
async function findNearestDistrictForPoint(lat, lng) {
  const districts = await prisma.district.findMany({
    where: { isActive: true },
    select: { id: true, centerLat: true, centerLng: true, boundary: true }
  });
  return findDistrictByBoundary(districts, { lat, lng }) || findNearestDistrict(districts, { lat, lng })?.district || null;
}

// Called after anything that can change a district's card: an order
// entering/leaving the active pipeline, or a driver's online/available/
// balance/location state changing. Broadcasts the full 9-row snapshot -
// with this few rows there is no benefit to diffing, and it keeps every
// listener trivially consistent.
let districtStatsBroadcast = Promise.resolve();
function broadcastDistrictStats() {
  // Read and emit in invocation order. A slow older snapshot must not arrive
  // after the recount that removed a claimed order from every driver's grid.
  districtStatsBroadcast = districtStatsBroadcast.then(async () => {
    try {
      await refreshOrderRecipients();
      const stats = await listDistrictsWithStats();
      getIO().to(rooms.districtsOverview()).emit('districts:stats', stats);
    } catch (err) {
      logger.warn({ err }, 'Failed to broadcast districts:stats');
    }
  });
  return districtStatsBroadcast;
}

module.exports = { listDistrictsWithStats, findDistrictForGpsPoint, findNearestDistrictForPoint, broadcastDistrictStats };
