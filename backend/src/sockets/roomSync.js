const { getIO } = require('../lib/socket');
const rooms = require('./rooms');
const logger = require('../config/logger');

// Keeps an already-connected driver's socket(s) district-room membership in
// sync with "should this driver currently receive order broadcasts for a
// district" - true iff they have a district, a positive balance, AND are
// toggled online (see driver/components/OnlineToggle.vue) - an offline
// driver must not see incoming orders or the districts grid at all. Three
// independent things can trigger this after the initial connect-time join
// in sockets/index.js: an admin changing the driver's balance
// (admin.service.js#adjustBalance), the driver's live GPS crossing into a
// different zone (driver.service.js#updateLocation), or the driver toggling
// online/offline themselves (driver.service.js#setStatus). All three call
// this instead of duplicating the join/leave logic.
async function syncDriverDistrictRoom(driverId, { previousDistrictId, districtId, eligible }) {
  try {
    const io = getIO();
    const sockets = await io.in(rooms.driver(driverId)).fetchSockets();
    if (!sockets.length) return;

    if (previousDistrictId && previousDistrictId !== districtId) {
      const previousRoom = rooms.district(previousDistrictId);
      sockets.forEach((socket) => socket.leave(previousRoom));
    }

    if (districtId) {
      const room = rooms.district(districtId);
      sockets.forEach((socket) => {
        if (eligible) socket.join(room);
        else socket.leave(room);
      });
    }
  } catch (err) {
    logger.warn({ err, driverId }, 'Failed to sync driver district room membership');
  }
}

module.exports = { syncDriverDistrictRoom };
