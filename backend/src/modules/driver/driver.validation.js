const { z } = require('zod');

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).optional(),
  speed: z.number().min(0).optional(),
  accuracy: z.number().min(0).optional()
});

const statusSchema = z.object({
  isOnline: z.boolean().optional(),
  isAvailable: z.boolean().optional()
});

const districtSchema = z.object({
  districtId: z.string().uuid('Некорректный идентификатор района')
});

const sendMessageSchema = z.object({
  body: z.string().trim().min(1, 'Сообщение не может быть пустым').max(2000),
  clientMessageId: z.string().uuid().optional()
});

const messagesQuerySchema = z.object({
  beforeMessageId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

const readMessageSchema = z.object({ throughMessageId: z.string().uuid().optional() });

const pushTokenSchema = z.object({
  token: z.string().trim().min(10, 'Некорректный push-токен')
});

module.exports = {
  locationSchema,
  statusSchema,
  districtSchema,
  sendMessageSchema,
  messagesQuerySchema,
  pushTokenSchema,
  readMessageSchema
};
