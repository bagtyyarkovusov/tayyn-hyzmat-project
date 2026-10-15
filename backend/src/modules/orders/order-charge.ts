import { Prisma } from '@prisma/client';

interface QuotedOrder {
  id: string;
  priceEstimated?: Prisma.Decimal.Value | null;
}

/**
 * Record the existing quoted-price debit or refund inside the caller's transaction.
 * Returns the new balance for broadcasts, or null when no positive charge exists.
 * Eligibility, order status and duplicate-operation guards belong to the caller.
 */
export async function recordOrderCharge(
  tx: Prisma.TransactionClient,
  order: QuotedOrder,
  userId: string,
  action: 'PAYMENT' | 'REFUND'
): Promise<Prisma.Decimal | null> {
  const price = new Prisma.Decimal(order.priceEstimated ?? 0);
  if (!price.greaterThan(0)) return null;

  const balance = await tx.balance.upsert({
    where: { userId },
    update: {},
    create: { userId, amount: 0 }
  });
  const payment = action === 'PAYMENT';
  const balanceAfter = payment
    ? new Prisma.Decimal(balance.amount).sub(price)
    : new Prisma.Decimal(balance.amount).add(price);
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
