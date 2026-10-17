const { Router } = require('express');

const authenticate = require('../middleware/authenticate');
const requireRole = require('../middleware/requireRole');
const requireApprovedDriver = require('../middleware/requireApprovedDriver');

const authRoutes = require('../modules/auth/auth.routes');
const driverRoutes = require('../modules/driver/driver.routes');
const ordersRoutes = require('../modules/orders/orders.routes');
const adminRoutes = require('../modules/admin/admin.routes');
const districtsRoutes = require('../modules/districts/districts.routes');
const geoRoutes = require('../modules/geo/geo.routes');

const router = Router();

router.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

router.use('/auth', authRoutes);
router.use('/native-shift', require('../modules/native-shift/native-shift.routes').nativeRoutes);
router.use('/native-notifications', require('../modules/notifications/notifications.routes').nativeRoutes);

// Every /driver/* and /orders/* route requires a logged-in, currently-approved driver.
router.use('/driver/shift', authenticate, requireRole('DRIVER'), requireApprovedDriver, require('../modules/native-shift/native-shift.routes').authenticatedRoutes);
router.use('/driver', authenticate, requireRole('DRIVER'), requireApprovedDriver, driverRoutes);
router.use('/driver/notifications', authenticate, requireRole('DRIVER'), requireApprovedDriver, require('../modules/notifications/notifications.routes').authenticatedRoutes);
router.use('/orders', authenticate, requireRole('DRIVER'), requireApprovedDriver, ordersRoutes);

// Every /admin/* route requires a logged-in admin.
router.use('/admin', authenticate, requireRole('ADMIN'), adminRoutes);

// The 9-district live overview is useful to both drivers (where's the
// demand?) and the future admin dashboard - any authenticated role can read it.
router.use('/districts', authenticate, districtsRoutes);

// Driver-scoped optional addresses, with shared persistent provider limits.
router.use('/geo', authenticate, geoRoutes);

module.exports = router;
