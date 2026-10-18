const { Router } = require('express');
import { z } from 'zod';
import asyncHandler from '../../utils/asyncHandler';
import validate from '../../utils/validate';
import ApiError from '../../utils/ApiError';
import * as service from './notifications';

const eventId = z.string().trim().min(1).max(300);
const registrationSchema = z.object({
  // A browser/native foreground installation can intentionally register
  // without an FCM token. It still receives Socket.IO events and can use the
  // opaque capability for canonical event verification.
  token: z.string().trim().min(1).max(4096).nullable().optional(),
  enabled: z.boolean().default(true)
});
const enabledSchema = z.object({ enabled: z.boolean() });
const eventSchema = z.object({ eventId });
const nativeTokenSchema = z.object({ token: z.string().trim().min(1).max(4096) });

function bearer(req: any) {
  const [scheme, token] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token) throw ApiError.unauthorized('Отсутствует токен уведомлений');
  return token;
}

// Mounted after authenticate/requireRole/requireApprovedDriver in routes/index.
export const authenticatedRoutes = Router();
authenticatedRoutes.get('/inbox', asyncHandler(async (req: any, res: any) => res.json(await service.inbox(req.driver))));
authenticatedRoutes.get('/settings', asyncHandler(async (req: any, res: any) => {
  res.json(await service.settings(req.driver));
}));
authenticatedRoutes.post('/settings', validate({ body: enabledSchema }), asyncHandler(async (req: any, res: any) => {
  res.json(await service.setEnabled(req.driver, req.body.enabled));
}));
authenticatedRoutes.post('/registration', validate({ body: registrationSchema }), asyncHandler(async (req: any, res: any) => {
  res.json(await service.register(req.driver, req.body.token ?? null, req.body.enabled));
}));
authenticatedRoutes.post('/ack', validate({ body: eventSchema }), asyncHandler(async (req: any, res: any) => {
  await service.ackSession(req.driver, req.body.eventId);
  res.status(204).send();
}));

// These routes intentionally do not use the normal JWT middleware. The WebView
// may be closed when Android receives an FCM data message; the short-lived,
// installation-bound opaque capability is the only credential accepted here.
export const nativeRoutes = Router();
nativeRoutes.post('/event', validate({ body: eventSchema }), asyncHandler(async (req: any, res: any) => {
  res.json(await service.verify(bearer(req), req.body.eventId));
}));
nativeRoutes.post('/ack', validate({ body: eventSchema }), asyncHandler(async (req: any, res: any) => {
  await service.ackNative(bearer(req), req.body.eventId);
  res.status(204).send();
}));
nativeRoutes.post('/token', validate({ body: nativeTokenSchema }), asyncHandler(async (req: any, res: any) => {
  await service.rotateToken(bearer(req), req.body.token);
  res.status(204).send();
}));
