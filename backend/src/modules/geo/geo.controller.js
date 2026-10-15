const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const service = require('./geo.service');

const reverse = asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw ApiError.badRequest('lat и lng обязательны и должны быть числами');
  }
  const result = await service.reverseGeocode(lat, lng);
  res.json(result);
});

module.exports = { reverse };
