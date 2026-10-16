const { z } = require('zod');

// Store one canonical Turkmen number. Formatting separators never change digits.
const phoneSchema = z.string().trim().max(32, 'Некорректный номер телефона')
  .regex(/^\+993[0-9 -]+$/, 'Укажите номер телефона +993 и 8 цифр')
  .transform(value => value.replace(/[ -]/g, ''))
  .pipe(z.string().regex(/^\+993\d{8}$/, 'После +993 должно быть 8 цифр'));

module.exports = { phoneSchema };
