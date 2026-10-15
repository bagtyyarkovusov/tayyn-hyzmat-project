const { Router } = require('express');
const controller = require('./districts.controller');

// Mounted in routes/index.js behind: authenticate (any role - driver or admin)
const router = Router();

router.get('/', controller.list);

module.exports = router;
