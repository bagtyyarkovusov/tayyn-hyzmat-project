const { Router } = require('express');
const { phoneSchema } = require('../../utils/phone-policy');
const validate = require('../../utils/validate');
const {
  createDriverSchema,
  driverIdParamSchema,
  orderIdParamSchema,
  listDriversQuerySchema,
  blockSchema,
  resolveOrderSchema,
  balanceAdjustSchema,
  historyQuerySchema,
  messageSchema,
  readMessageSchema,
  listOrdersQuerySchema,
  activityQuerySchema,
  vehicleSchema,
  districtIdParamSchema,
  districtBoundarySchema
} = require('./admin.validation');
const controller = require('./admin.controller');
const credentials = require('./driver-credentials');
const asyncHandler = require('../../utils/asyncHandler');
const { z } = require('zod');
const { newPasswordSchema } = require('../../utils/password-policy');
const passwordSchema = z.object({ password: newPasswordSchema, passwordConfirmation: newPasswordSchema }).strict().refine(value => value.password === value.passwordConfirmation, { message: 'Пароли не совпадают', path: ['passwordConfirmation'] });
const profileSchema = z.object({ fullName: z.string().trim().min(2).max(120), phone: phoneSchema }).strict();
const { createOrderSchema, privateOfferSchema } = require('../orders/orders.validation');

// Mounted in routes/index.js behind: authenticate, requireRole('ADMIN')
const router = Router();

router.get('/overview', asyncHandler(async (_req, res) => res.json(await require('./overview').getOverview())));
router.get('/overview/today', asyncHandler(async (_req, res) => res.json(await require('./today-overview').getTodayOverview())));

router.post('/drivers/:id/password', validate({ params: driverIdParamSchema, body: passwordSchema }), asyncHandler(async (req, res) => { res.json(await credentials.resetDriverPassword(req.params.id, req.body.password)); }));
router.post('/drivers/:id/profile', validate({ params: driverIdParamSchema, body: profileSchema }), asyncHandler(async (req, res) => { res.json(await credentials.updateDriverProfile(req.params.id, req.body)); }));
router.post('/drivers', validate({ body: createDriverSchema }), controller.createDriver);
router.get('/drivers', validate({ query: listDriversQuerySchema }), controller.listDrivers);
router.get('/drivers/:id', validate({ params: driverIdParamSchema }), controller.getDriver);
router.post('/drivers/:id/approve', validate({ params: driverIdParamSchema }), controller.approveDriver);
router.post(
  '/drivers/:id/block',
  validate({ params: driverIdParamSchema, body: blockSchema }),
  controller.blockDriver
);
router.post('/drivers/:id/unblock', validate({ params: driverIdParamSchema }), controller.unblockDriver);
// Single-device login approval - see admin.service.js#approveDevice.
router.post('/drivers/:id/approve-device', validate({ params: driverIdParamSchema }), controller.approveDevice);
router.post('/drivers/:id/reject-device', validate({ params: driverIdParamSchema }), controller.rejectDevice);
router.post(
  '/drivers/:id/balance',
  validate({ params: driverIdParamSchema, body: balanceAdjustSchema }),
  controller.adjustBalance
);
// Plate number / vehicle details - moved here from a driver self-service
// route (see admin.service.js#updateVehicle) so drivers can view but not
// change this themselves.
router.post(
  '/drivers/:id/vehicle',
  validate({ params: driverIdParamSchema, body: vehicleSchema }),
  controller.updateVehicle
);
// Hard delete - see admin.service.js#deleteDriver for exactly what goes
// (everything personal) and what stays (their orders, with driverId nulled).
router.delete('/drivers/:id', validate({ params: driverIdParamSchema }), controller.deleteDriver);

router.get(
  '/drivers/:id/history',
  validate({ params: driverIdParamSchema, query: historyQuerySchema }),
  controller.history
);
router.post('/messages', validate({ body: messageSchema }), controller.sendMessage);
// Global "new message" badge (AdminNav.vue) - separate from a specific
// driver's thread, see admin.service.js#listUnreadDriverIds.
router.get('/messages/unread', controller.unreadDriverIds);
router.get(
  '/drivers/:id/messages',
  validate({ params: driverIdParamSchema, query: historyQuerySchema }),
  controller.driverMessages
);
// Clears the "new message" badge (see admin.service.js#markMessagesRead) -
// called when an admin opens the thread, not tied to fetching messages
// itself so a GET stays side-effect-free.
router.post(
  '/drivers/:id/messages/read',
  validate({ params: driverIdParamSchema }),
  validate({ body: readMessageSchema }),
  controller.markMessagesRead
);

// Manual/phone dispatch - there is no client app yet (see migration plan),
// so this is currently the only way an order enters the system at all.
router.post('/orders/:id/private-offer', validate({ params: orderIdParamSchema, body: privateOfferSchema }), controller.privateOffer);
router.post('/orders', validate({ body: createOrderSchema }), controller.createOrder);
router.get('/orders', validate({ query: listOrdersQuerySchema }), controller.listOrders);
// Dispatcher cancellation is available only before STARTED; completion is audited separately.
router.post('/orders/:id/cancel', validate({ params: orderIdParamSchema, body: blockSchema }), controller.cancelOrder);
router.post('/orders/:id/force-resolve', validate({ params: orderIdParamSchema, body: resolveOrderSchema }), controller.forceResolveOrder);

// "Кто и что делал" - see admin.service.js#getActivity for exactly what
// this aggregates and its one honest gap (order cancellations have no actor).
router.get('/activity', validate({ query: activityQuerySchema }), controller.activity);

// "Границы районов" editor (AdminDistrictBoundaries.vue) - separate from
// the public/shared GET /districts (live order/driver counts, any
// authenticated role) since this returns raw geometry instead.
router.get('/districts', controller.listDistricts);
router.patch(
  '/districts/:id/boundary',
  validate({ params: districtIdParamSchema, body: districtBoundarySchema }),
  controller.updateDistrictBoundary
);

module.exports = router;
