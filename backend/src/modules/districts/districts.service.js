const prisma = require('../../lib/prisma');
const { getIO } = require('../../lib/socket');
const rooms = require('../../sockets/rooms');
const logger = require('../../config/logger');
const { findNearestDistrict, findDistrictByBoundary } = require('../../utils/geo');

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

  const [orderCounts, candidateFreeDrivers] = await Promise.all([
    prisma.order.groupBy({
      by: ['districtId'],
      where: { districtId: { not: null }, status: { notIn: ACTIVE_ORDER_STATUSES_EXCLUDED } },
      _count: { _all: true }
    }),
    // Balance is a relation, not a scalar on Driver, so it's filtered and
    // tallied here in JS rather than in a groupBy - simple and unambiguous
    // for the driver counts a single city instance actually has.
    prisma.driver.findMany({
      where: { districtId: { not: null }, status: 'APPROVED', isOnline: true, isAvailable: true },
      select: { districtId: true, user: { select: { balance: { select: { amount: true } } } } }
    })
  ]);

  const orderCountByDistrict = new Map(orderCounts.map((row) => [row.districtId, row._count._all]));

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
    activeOrders: orderCountByDistrict.get(district.id) || 0,
    freeDrivers: freeDriverCountByDistrict.get(district.id) || 0
  }));
}

// Prefers a real drawn boundary (see the admin "Границы районов" editor,
// admin.service.js#updateDistrictBoundary) over the older nearest-center
// guess - a point actually inside a district's polygon wins regardless of
// which center it's closer to. Falls back to nearest-center for any point
// no polygon claims, so districts without a drawn boundary yet (or a point
// genuinely outside all of them) still resolve to *something*, exactly as
// before this function existed.
async function findNearestDistrictForPoint(lat, lng) {
  const districts = await prisma.district.findMany({
    where: { isActive: true },
    select: { id: true, centerLat: true, centerLng: true, boundary: true }
  });
  const point = { lat, lng };
  const byBoundary = findDistrictByBoundary(districts, point);
  if (byBoundary) return byBoundary;
  const result = findNearestDistrict(districts, point);
  return result ? result.district : null;
}

// Called after anything that can change a district's card: an order
// entering/leaving the active pipeline, or a driver's online/available/
// balance/location state changing. Broadcasts the full 9-row snapshot -
// with this few rows there is no benefit to diffing, and it keeps every
// listener trivially consistent.
async function broadcastDistrictStats() {
  try {
    const stats = await listDistrictsWithStats();
    getIO().to(rooms.districtsOverview()).emit('districts:stats', stats);
  } catch (err) {
    logger.warn({ err }, 'Failed to broadcast districts:stats');
  }
}

module.exports = { listDistrictsWithStats, findNearestDistrictForPoint, broadcastDistrictStats };
