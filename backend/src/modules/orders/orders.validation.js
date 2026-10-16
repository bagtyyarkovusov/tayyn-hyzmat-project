const { z } = require('zod');
const { phoneSchema } = require('../../utils/phone-policy');

const orderIdSchema = z.object({
  orderId: z.string().uuid('Некорректный идентификатор заказа')
});

// Explicit manual acceptance supports 5 / 10 / 15 / 20 minute arrival estimates.
// Five minutes remains the default when the caller omits the estimate.
const acceptSchema = z.object({
  orderId: z.string().uuid('Некорректный идентификатор заказа'),
  etaMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).default(5)
});

const cancelSchema = z.object({
  orderId: z.string().uuid('Некорректный идентификатор заказа'),
  reason: z.string().trim().max(300).optional()
});

// Phone dispatch requires a region, customer phone and manually entered price.
// Addresses, map coordinates and note are optional. Missing
// pickup coordinates use the selected region centre for existing storage.
const createOrderSchema = z.object({
  pickupLat: z.number().min(-90).max(90).optional(),
  pickupLng: z.number().min(-180).max(180).optional(),
  pickupAddress: z.string().trim().max(300).optional(),
  dropoffLat: z.number().min(-90).max(90).optional(),
  dropoffLng: z.number().min(-180).max(180).optional(),
  dropoffAddress: z.string().trim().max(300).optional(),
  priceEstimated: z.number().finite().positive(),
  clientPhone: phoneSchema,
  districtId: z.string().uuid('Выберите район'),
  privateOfferDriverId: z.string().uuid().optional(),
  note: z.string().trim().max(500).optional()
  });

// GET /orders/available?districtId=... - districtId is optional (defaults
// to the driver's own district, see orders.service.js#listAvailable) so a
// driver can look at any of the 9 district cards, not just the one they're
// physically in. Viewing is open city-wide; accept() still enforces the
// driver's own district regardless of what this returned.
const listAvailableQuerySchema = z.object({
  districtId: z.string().uuid('Некорректный идентификатор района').optional()
});

const privateOfferSchema = z.object({ driverId: z.string().uuid() });

const privateAcceptSchema = acceptSchema.extend({ privateOfferExpiresAt: z.string().datetime() });

module.exports = { privateAcceptSchema, privateOfferSchema, orderIdSchema, acceptSchema, cancelSchema, createOrderSchema, listAvailableQuerySchema };
