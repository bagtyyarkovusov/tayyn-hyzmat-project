const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const { driverAddress } = require('./driver-address');

const reverse = asyncHandler(async (req, res) => {
  if (req.user.role !== 'ADMIN') throw ApiError.forbidden();
  if (typeof req.query.lat !== 'string' || !req.query.lat.trim() || typeof req.query.lng !== 'string' || !req.query.lng.trim()) throw ApiError.badRequest('lat и lng обязательны');
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw ApiError.badRequest('lat и lng обязательны и должны быть числами');
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) throw ApiError.badRequest('Неверные координаты');
  // Legacy order-map contract: optional manual address fields remain usable.
  // Automatic fleet lookups must use the driver-scoped, budgeted boundary.
  res.set('Cache-Control', 'no-store');
  res.json({ address: null, position: { lat, lng }, reason: 'unavailable' });
});

const address = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await driverAddress(req.user, req.params.driverId));
});
module.exports = { reverse, address };
