const { Router } = require('express');
const { z } = require('zod');
const asyncHandler = require('../../utils/asyncHandler');
const validate = require('../../utils/validate');
const ApiError = require('../../utils/ApiError');
const service = require('./native-shift.service');
const { locationSchema } = require('../driver/driver.validation');
const authenticatedRoutes = Router();
const nativeRoutes = Router();
const startSchema = z.object({ deviceId: z.string().min(1).max(200), refreshToken: z.string().min(20).max(1000) });
authenticatedRoutes.post('/', validate({ body: startSchema }), asyncHandler(async (req, res) => {
  res.status(201).json(await service.start(req.driver, req.body.deviceId, req.body.refreshToken, req.user.credentialVersion));
}));
authenticatedRoutes.post('/stop', asyncHandler(async (req, res) => { await service.stop(req.driver); res.status(204).send(); }));
function token(req) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
  if (!match) throw ApiError.unauthorized();
  return match[1];
}
nativeRoutes.post('/tick', validate({ body: locationSchema.extend({ recordedAt: z.string().datetime() }) }), asyncHandler(async (req, res) => {
  res.json(await service.tick(token(req), req.body));
}));
nativeRoutes.post('/stop', asyncHandler(async (req, res) => { await service.stopToken(token(req)); res.status(204).send(); }));
module.exports = { authenticatedRoutes, nativeRoutes };
