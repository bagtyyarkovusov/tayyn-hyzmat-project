const { z } = require('zod');

const phoneSchema = z
  .string()
  .trim()
  .min(6, 'Некорректный номер телефона')
  .max(20, 'Некорректный номер телефона')
  .regex(/^\+?[0-9\s-]+$/, 'Номер телефона может содержать только цифры, пробелы, "-" и "+"');

const registerDriverSchema = z.object({
  phone: phoneSchema,
  fullName: z.string().trim().min(2, 'Укажите имя').max(120),
  password: z.string().min(6, 'Пароль должен быть не короче 6 символов').max(128)
});

const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1, 'Укажите пароль'),
  // Driver-only device binding (see auth.service.js#login) - optional so
  // admin/client logins and any not-yet-updated driver client keep working
  // unchanged; the single-device rule only ever activates when this is sent.
  deviceId: z.string().trim().min(4).max(200).optional(),
  // Human-readable "Samsung SM-A047F, Android 13" from @capacitor/device,
  // purely for the admin panel to show something meaningful instead of an
  // opaque UUID - never used for any actual matching/security decision.
  deviceLabel: z.string().trim().max(200).optional()
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10, 'Некорректный refresh-токен')
});

module.exports = { registerDriverSchema, loginSchema, refreshSchema };
