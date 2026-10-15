const asyncHandler = require('../../utils/asyncHandler');
const service = require('./districts.service');
const prisma = require('../../lib/prisma');
const { hasFreshGps } = require('../driver/gps-eligibility');

const list = asyncHandler(async (req, res) => {
  const districts = await service.listDistrictsWithStats();
  if (req.user.role === 'DRIVER') {
    const driver = await prisma.driver.findUnique({ where: { id: req.user.driverId } });
    if (!driver || driver.status !== 'APPROVED' || !driver.isOnline || !hasFreshGps(driver)) {
      return res.json(districts.map(region => ({ ...region, activeOrders: 0, freeDrivers: 0, onlineDrivers: 0 })));
    }
  }
  res.json(districts);
});

module.exports = { list };
