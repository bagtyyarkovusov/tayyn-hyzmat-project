const { z } = require('zod');
const { newPasswordSchema } = require('../../utils/password-policy');

const { phoneSchema } = require('../../utils/phone-policy');

const registerDriverSchema = z.object({
  phone: phoneSchema,
  fullName: z.string().trim().min(2, 'Укажите имя').max(120),
  password: newPasswordSchema,
  // Accepted so 1.21 APKs (which send an installation id at signup) are not
  // rejected; registration creates no session or device row and ignores them.
  deviceId: z.string().trim().min(4).max(200).optional(),
  deviceLabel: z.string().trim().max(200).optional()
});

const loginSchema = z.object({
  phone: phoneSchema,
  password: z.string().min(1, 'Укажите пароль'),
  // Conditional driver requirement is enforced after account/password validation.
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
