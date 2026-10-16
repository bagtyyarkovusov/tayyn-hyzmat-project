import { Prisma } from '@prisma/client';
import { MAX_WALLET_AMOUNT } from '../../utils/money-policy';
import { lockedBalance } from '../balance/locked-balance';
const ApiError = require('../../utils/ApiError');

interface QuotedOrder {
  id: string;
  priceEstimated?: Prisma.Decimal.Value | null;
}

/**
 * Record the existing quoted-price debit or refund inside the caller's transaction.
 * Returns the new balance for broadcasts, or null when no positive charge exists.
 * Workflow eligibility, order status and duplicate-operation guards belong to the caller.
 * A debit must be covered by the locked balance; refunds never use that guard.
 */
export async function recordOrderCharge(
  tx: Prisma.TransactionClient,
  order: QuotedOrder,
  userId: string,
  action: 'PAYMENT' | 'REFUND'
): Promise<Prisma.Decimal | null> {
  const price = new Prisma.Decimal(order.priceEstimated ?? 0);
  if (!price.greaterThan(0)) return null;

  const balance = await lockedBalance(tx, userId);
  const payment = action === 'PAYMENT';
  if (payment && balance.amount.lessThan(price)) {
    throw ApiError.forbidden(`Недостаточно средств. Пополните баланс до ${price.toFixed(2)} TMT, чтобы принять заказ`);
  }
  const balanceAfter = payment
    ? new Prisma.Decimal(balance.amount).sub(price)
    : new Prisma.Decimal(balance.amount).add(price);
  if (balanceAfter.gt(MAX_WALLET_AMOUNT)) {
    throw ApiError.badRequest('Возврат превысит максимальный баланс. Сначала уменьшите баланс водителя');
  }
  await tx.balance.update({ where: { id: balance.id }, data: { amount: balanceAfter } });
  await tx.transaction.create({
    data: {
      balanceId: balance.id,
      orderId: order.id,
      type: action,
      amount: payment ? price.negated() : price,
      balanceAfter,
      note: payment
        ? `Заказ #${order.id}: цена поездки списана при принятии`
        : `Заказ #${order.id}: возврат за отменённую поездку`
    }
  });
  return balanceAfter;
}
