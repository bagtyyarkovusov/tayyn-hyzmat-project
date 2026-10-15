const { Router } = require('express');
const controller = require('./geo.controller');

// Mounted in routes/index.js behind: authenticate (any role - driver or
// admin both need reverse geocoding, same as /districts).
const router = Router();

router.get('/reverse', controller.reverse);

module.exports = router;
