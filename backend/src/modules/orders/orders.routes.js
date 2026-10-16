const { Router } = require('express');
const validate = require('../../utils/validate');
const { privateAcceptSchema, orderIdSchema, acceptSchema, cancelSchema, listAvailableQuerySchema } = require('./orders.validation');
const controller = require('./orders.controller');

// Mounted in routes/index.js behind: authenticate, requireRole('DRIVER'), requireApprovedDriver
const router = Router();

router.get('/available', validate({ query: listAvailableQuerySchema }), controller.available);
router.post('/private-offer/accept', validate({ body: privateAcceptSchema }), controller.acceptPrivateOffer);
router.get('/private-offer', controller.privateOffer);
router.post('/private-offer/decline', validate({ body: privateAcceptSchema }), controller.declinePrivateOffer);
router.get('/current', controller.current);
router.post('/accept', validate({ body: acceptSchema }), controller.accept);
// "Ожидаю" (arrived at pickup, wait-timer starts) - not named in the
// original 4-endpoint spec, but the WAITING status can't be reached without it.
router.post('/waiting', validate({ body: orderIdSchema }), controller.waiting);
router.post('/start', validate({ body: orderIdSchema }), controller.start); // "Начать поездку": WAITING -> STARTED
router.post('/complete', validate({ body: orderIdSchema }), controller.complete);
// Not in the original spec either - CANCELLED is a listed status and a
// no-show at pickup is the realistic way to reach it.
router.post('/cancel', validate({ body: cancelSchema }), controller.cancel);

module.exports = router;
