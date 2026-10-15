const { verifyAccessToken } = require('../utils/jwt');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

// Verifies the Bearer access token and attaches the decoded claims as
// req.user = { id, role, driverId?, adminId? }. Does NOT re-hit the database
// on every request (that's left to route-specific middleware such as
// requireApprovedDriver, which needs fresh status anyway).
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw ApiError.unauthorized('Отсутствует токен авторизации');
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = {
      id: payload.sub,
      role: payload.role,
      driverId: payload.driverId,
      adminId: payload.adminId
    };
    next();
  } catch (err) {
    throw ApiError.unauthorized('Недействительный или истёкший токен');
  }
});

module.exports = authenticate;
