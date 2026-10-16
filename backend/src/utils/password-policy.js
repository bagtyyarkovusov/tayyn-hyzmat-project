const { z } = require('zod');

// bcrypt considers only the first 72 UTF-8 bytes. Apply this same policy
// whenever credentials are created or replaced, without trimming passwords
// or imposing letter/symbol requirements on drivers.
const newPasswordSchema = z.string()
  .min(6, 'Пароль должен быть не короче 6 символов')
  .max(72, 'Пароль должен занимать не более 72 байт')
  .refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Пароль должен занимать не более 72 байт');

module.exports = { newPasswordSchema };
