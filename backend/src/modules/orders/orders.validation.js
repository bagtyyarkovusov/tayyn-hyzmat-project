const { z } = require('zod');

const orderIdSchema = z.object({
  orderId: z.string().uuid('Некорректный идентификатор заказа')
});

// "Принять через: 5 / 10 / 15 / 20 минут" - and the auto-accept-after-5-min
// timeout also sends 5, so 5 doubles as the sensible server-side default.
const acceptSchema = z.object({
  orderId: z.string().uuid('Некорректный идентификатор заказа'),
  etaMinutes: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).default(5)
});

const cancelSchema = z.object({
  orderId: z.string().uuid('Некорректный идентификатор заказа'),
  reason: z.string().trim().max(300).optional()
});

// Admin/manual dispatch - see orders.service.js#createOrder. There is no
// client app yet, so this is the only way an order currently enters the
// system; pickup coordinates are required (that's what places it in a
// district's broadcast), everything else is optional. districtId lets the
// dispatching admin pick the district explicitly instead of relying purely
// on nearest-center matching against the pickup point they clicked on the
// map - the admin usually knows which district a phone call actually
// belongs to better than an approximate map click does.
const createOrderSchema = z
  .object({
    // Optional so an admin dispatching by phone can just pick a district and
    // send it - the pickup point is then the district's own centre, filled
    // in server-side (orders.service.js#createOrder). The frontend used to
    // compute that centre itself from the districts list, but GET /districts
    // never returned centerLat/centerLng, so it sent NaN -> null and every
    // such order was rejected with "Некорректные данные запроса".
    pickupLat: z.number().min(-90).max(90).optional(),
    pickupLng: z.number().min(-180).max(180).optional(),
    pickupAddress: z.string().trim().max(300).optional(),
    dropoffLat: z.number().min(-90).max(90).optional(),
    dropoffLng: z.number().min(-180).max(180).optional(),
    dropoffAddress: z.string().trim().max(300).optional(),
    priceEstimated: z.number().positive().optional(),
    clientPhone: z.string().trim().max(20).optional(),
    districtId: z.string().uuid('Некорректный идентификатор района').optional(),
    note: z.string().trim().max(500).optional()
  })
  .refine((data) => (data.pickupLat !== undefined && data.pickupLng !== undefined) || Boolean(data.districtId), {
    message: 'Укажите точку «Откуда» на карте или выберите район',
    path: ['pickupLat']
  });

// GET /orders/available?districtId=... - districtId is optional (defaults
// to the driver's own district, see orders.service.js#listAvailable) so a
// driver can look at any of the 9 district cards, not just the one they're
// physically in. Viewing is open city-wide; accept() still enforces the
// driver's own district regardless of what this returned.
const listAvailableQuerySchema = z.object({
  districtId: z.string().uuid('Некорректный идентификатор района').optional()
});

module.exports = { orderIdSchema, acceptSchema, cancelSchema, createOrderSchema, listAvailableQuerySchema };
