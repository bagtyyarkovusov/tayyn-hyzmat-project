const { Router } = require('express');
const validate = require('../../utils/validate');
const { authLimiter } = require('../../middleware/rateLimit');
const { registerDriverSchema, loginSchema, refreshSchema } = require('./auth.validation');
const controller = require('./auth.controller');

const router = Router();

// POST /auth/register - driver self-registration (phone, fullName, password).
// Creates an active account and device-bound session without starting a shift.
router.post('/register', authLimiter, validate({ body: registerDriverSchema }), controller.register);

// POST /auth/login - shared login for all roles (driver/admin/client).
router.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);

// POST /auth/refresh - exchange a valid refresh token for a new token pair.
router.post('/refresh', authLimiter, validate({ body: refreshSchema }), controller.refresh);

// POST /auth/logout - revoke a refresh token.
router.post('/logout', validate({ body: refreshSchema }), controller.logout);

module.exports = router;
