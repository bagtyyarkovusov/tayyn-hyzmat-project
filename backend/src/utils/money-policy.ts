import { Prisma } from '@prisma/client';
import { z } from 'zod';

export const MAX_WALLET_AMOUNT = new Prisma.Decimal('9999999999.99');

/** Reject unrepresentable money before PostgreSQL can round or overflow it. */
export function moneySchema(maximum: string) {
  return z.number().finite().refine(value => {
    const amount = new Prisma.Decimal(value);
    return amount.decimalPlaces() <= 2 && amount.abs().lte(maximum);
  }, 'Укажите сумму с точностью до 0,01 в допустимом диапазоне');
}
