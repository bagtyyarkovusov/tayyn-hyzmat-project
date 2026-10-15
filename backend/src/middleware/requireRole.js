const ApiError = require('../utils/ApiError');

// requireRole('DRIVER'), requireRole('ADMIN', 'DRIVER'), etc. Must run after
// `authenticate`.
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(ApiError.forbidden('Недостаточно прав для этого действия'));
  }
  next();
};

module.exports = requireRole;
