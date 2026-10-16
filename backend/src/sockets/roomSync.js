const { getIO } = require('../lib/socket');
const prisma = require('../lib/prisma');
const rooms = require('./rooms');
const logger = require('../config/logger');
const { hasFreshGps, GPS_FRESHNESS_MS } = require('../modules/driver/gps-eligibility');

const expiryTimers = new Map();
const pendingSync = new Map();

// Every caller rechecks persisted eligibility, including balance and manual-region
// changes. Caller-provided eligibility must never override the GPS requirement.
async function syncDriverDistrictRoomNow(driverId) {
  try {
    const io = getIO();
    let driver = await prisma.driver.findUnique({ where: { id: driverId }, include: { user: { include: { balance: true } } } });
    const timer = expiryTimers.get(driverId);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(driverId);
    if (driver && driver.isOnline && !hasFreshGps(driver)) {
      const changed = await prisma.driver.updateMany({
        where: { id: driverId, isOnline: true, lastLocationAt: driver.lastLocationAt },
        data: { isOnline: false }
      });
      if (changed.count) io.to(rooms.driver(driverId)).to(rooms.admins()).emit('driver:status', {
        driverId, isOnline: false, isAvailable: driver.isAvailable, updatedAt: new Date().toISOString(), reason: 'GPS_REQUIRED'
      });
      driver = await prisma.driver.findUnique({ where: { id: driverId }, include: { user: { include: { balance: true } } } });
    }
    const sockets = await io.in(rooms.driver(driverId)).fetchSockets();
    const freshOnline = driver && driver.status === 'APPROVED' && driver.isOnline && hasFreshGps(driver);
    const receivesOrders = freshOnline && driver.districtId && driver.user.balance && Number(driver.user.balance.amount) > 0;
    for (const socket of sockets) {
      for (const room of socket.rooms) {
        if (room.startsWith('district:')) await socket.leave(room);
      }
      const ownsShift = freshOnline && socket.data.credentials?.deviceId === driver.shiftDeviceId;
      if (ownsShift) await socket.join(rooms.districtsOverview());
      else await socket.leave(rooms.districtsOverview());
      if (receivesOrders && ownsShift) await socket.join(rooms.district(driver.districtId));
    }
    if (freshOnline) {
      const delay = Math.max(1, driver.lastLocationAt.getTime() + GPS_FRESHNESS_MS - Date.now());
      const expiry = setTimeout(() => {
        syncDriverDistrictRoom(driverId).then(() => require('../modules/districts/districts.service').broadcastDistrictStats());
      }, delay);
      expiry.unref();
      expiryTimers.set(driverId, expiry);
    }
  } catch (err) {
    logger.warn({ err, driverId }, 'Failed to sync driver district room membership');
    // Fail closed if eligibility cannot be checked.
    const sockets = await getIO().in(rooms.driver(driverId)).fetchSockets();
    for (const socket of sockets) {
      for (const room of socket.rooms) if (room.startsWith('district:') || room === rooms.districtsOverview()) await socket.leave(room);
    }
  }
}

function syncDriverDistrictRoom(driverId) {
  const previous = pendingSync.get(driverId) || Promise.resolve();
  const current = previous.then(() => syncDriverDistrictRoomNow(driverId));
  pendingSync.set(driverId, current);
  return current.finally(() => { if (pendingSync.get(driverId) === current) pendingSync.delete(driverId); });
}

// Revalidate at delivery time as well as on timers, so event-loop delays and
// reconnects cannot leave expired sockets receiving offers or live queues.
async function refreshOrderRecipients() {
  const sockets = await getIO().in(rooms.drivers()).fetchSockets();
  const driverIds = new Set(sockets.map(socket => socket.data.user.driverId));
  await Promise.all([...driverIds].map(driverId => syncDriverDistrictRoom(driverId)));
}

module.exports = { syncDriverDistrictRoom, refreshOrderRecipients };
