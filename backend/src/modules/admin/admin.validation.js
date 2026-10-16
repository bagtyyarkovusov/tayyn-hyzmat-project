const { z } = require('zod');
const { registerDriverSchema } = require('../auth/auth.validation');
const createDriverSchema = registerDriverSchema;

const driverIdParamSchema = z.object({
  id: z.string().uuid('Некорректный идентификатор водителя')
});

const orderIdParamSchema = z.object({
  id: z.string().uuid('Некорректный идентификатор заказа')
});

const listDriversQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'BLOCKED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const blockSchema = z.object({
  reason: z.string().trim().max(500).optional()
});

const resolveOrderSchema = z.object({
  reason: z.string().trim().min(1, 'Укажите причину принудительного завершения').max(500)
});

const balanceAdjustSchema = z.object({
  amount: z.number().refine((v) => v !== 0, 'Сумма не может быть равна нулю'),
  type: z.enum(['TOPUP', 'WITHDRAWAL', 'ADJUSTMENT', 'BONUS']).default('ADJUSTMENT'),
  note: z.string().trim().max(500).optional()
});

const historyQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const messageSchema = z
  .object({
    driverId: z.string().uuid().optional(),
    broadcast: z.boolean().optional().default(false),
    title: z.string().trim().max(120).optional(),
    body: z.string().trim().min(1, 'Сообщение не может быть пустым').max(2000),
    clientMessageId: z.string().uuid().optional()
  })
  .refine((data) => data.broadcast || data.driverId, {
    message: 'Укажите driverId или broadcast: true'
  });

const readMessageSchema = z.object({ throughMessageId: z.string().uuid().optional() });

const listOrdersQuerySchema = z.object({
  status: z.enum(['active', 'accepted', 'completed', 'cancelled', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

// Same shape as driver.validation.js#vehicleSchema (this replaces that
// self-service route - see admin.service.js#updateVehicle) - kept as its
// own copy rather than a cross-module import since the two modules'
// validation schemas are otherwise independent and this is small enough
// not to be worth coupling them together.
const vehicleSchema = z.object({
  plateNumber: z.string().trim().min(2, 'Укажите номер машины').max(20),
  make: z.string().trim().max(50).optional(),
  model: z.string().trim().max(50).optional(),
  color: z.string().trim().max(30).optional()
});

const districtIdParamSchema = z.object({
  id: z.string().uuid('Некорректный идентификатор района')
});

// One point is [lat, lng] - matches Yandex's own ymaps.Polygon geometry
// order (see AdminDistrictBoundaries.vue), not GeoJSON's [lng, lat]. A ring
// needs at least 3 points to be a polygon at all; `boundary` is an array of
// rings (currently always exactly one - see schema.prisma's District.boundary
// comment) so a hole could be added later without another migration.
const latLngPoint = z.tuple([z.number().min(-90).max(90), z.number().min(-180).max(180)]);
const districtBoundarySchema = z.object({
  boundary: z.array(z.array(latLngPoint).min(3, 'Нужно минимум 3 точки')).min(1)
});

module.exports = {
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
};
