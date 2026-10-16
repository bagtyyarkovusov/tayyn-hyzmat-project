const { Router } = require('express');
const controller = require('./geo.controller');

// Authentication is inherited; driver-address additionally enforces actor/driver ownership.
const router = Router();

router.get('/drivers/:driverId/address', controller.address);
router.get('/reverse', controller.reverse);

module.exports = router;
