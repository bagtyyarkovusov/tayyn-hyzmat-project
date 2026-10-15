const asyncHandler = require('../../utils/asyncHandler');
const service = require('./districts.service');

const list = asyncHandler(async (req, res) => {
  const districts = await service.listDistrictsWithStats();
  res.json(districts);
});

module.exports = { list };
