const { verifyAccessToken } = require('../utils/jwt');
const { validateCredentialSession } = require('../modules/auth/credential-session');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

// Check the persisted credential version so changed driver credentials revoke
// existing access tokens immediately. Route middleware handles driver approval.
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    throw ApiError.unauthorized('Отсутствует токен авторизации');
  }

  try {
    const payload = verifyAccessToken(token);
    await validateCredentialSession(payload);
    req.user = {
      id: payload.sub,
      credentialVersion: payload.credentialVersion ?? 0,
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
