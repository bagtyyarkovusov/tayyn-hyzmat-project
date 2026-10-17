const { Router } = require('express');
const validate = require('../../utils/validate');
const {
  locationSchema,
  statusSchema,
  sendMessageSchema,
  messagesQuerySchema,
  pushTokenSchema,
  readMessageSchema
} = require('./driver.validation');
const controller = require('./driver.controller');

// Mounted in routes/index.js behind: authenticate, requireRole('DRIVER'), requireApprovedDriver
const router = Router();

router.get('/profile', controller.profile);
router.get('/balance', controller.balance);
router.post('/location', validate({ body: locationSchema }), controller.postLocation);

// Not in the original spec list, but required for the "online status"
// websocket feature to have anything to toggle - see driver.service.js.
router.post('/status', validate({ body: statusSchema }), controller.postStatus);

// Old clients receive an explicit retirement response. No body is accepted
// as authority for a region; shift GPS derives it from saved polygons.
router.post('/district', controller.postDistrict);

// The driver's own trips + balance movements, for the profile screen -
// same data the admin sees for them, scoped to the caller (see
// driver.service.js#getHistory). Reuses messagesQuerySchema: identical
// page/limit shape, nothing message-specific about it.
router.get('/history', validate({ query: messagesQuerySchema }), controller.getHistory);

// Чат Админ ↔ водитель. Not in any prior spec message either - "Чат:
// Админ ↔ водитель" only makes sense bidirectionally, and the admin side
// (POST /admin/messages) already existed with no way for the driver to
// reply.
router.get('/messages', validate({ query: messagesQuerySchema }), controller.getMessages);
router.post('/messages', validate({ body: sendMessageSchema }), controller.postMessage);
// Marks everything the admin has sent so far as seen - see
// driver.service.js#markChatRead.
router.post('/messages/read', validate({ body: readMessageSchema }), controller.postMessagesRead);

// Driver APK only - stores the FCM token @capacitor/push-notifications
// hands back, so a future push-sending feature knows where to deliver to.
router.post('/push-token', validate({ body: pushTokenSchema }), controller.postPushToken);

module.exports = router;
