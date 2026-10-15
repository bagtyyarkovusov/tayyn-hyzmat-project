const rateLimit = require('express-rate-limit');

// Brute-force protection on auth endpoints. Keyed by IP; tune per your
// deployment (behind a proxy, make sure `app.set('trust proxy', ...)` is
// configured correctly so req.ip is the real client IP).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Слишком много попыток. Попробуйте позже.' }
});

module.exports = { authLimiter };
