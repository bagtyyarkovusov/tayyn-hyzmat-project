import { Prisma } from '@prisma/client';
import { lockedBalance, walletSummary } from '../balance/locked-balance';
const ApiError = require('../../utils/ApiError');

type Order = { id: string; orderNumber: number; offerAttemptId: string; priceEstimated?: Prisma.Decimal.Value | null };

// Callers hold driver, order, then wallet locks. The accepted quote is immutable.
export async function holdOrderQuote(tx: Prisma.TransactionClient, order: Order, driverId: string, userId: string) {
  const balance = await lockedBalance(tx, userId);
  const summary = await walletSummary(tx, balance);
  const quote = Prisma.Decimal.max(0, new Prisma.Decimal(order.priceEstimated ?? 0));
  if (summary.available.lt(quote)) throw ApiError.forbidden(`Недостаточно средств. Доступно ${summary.available.toFixed(2)} TMT`);
  await tx.orderAssignment.create({ data: { orderId: order.id, driverId, offerAttemptId: order.offerAttemptId, quotedAmount: quote, fundingState: quote.gt(0) ? 'HELD' : 'UNPRICED' } });
  return walletSummary(tx, balance);
}

export async function captureOrderQuote(tx: Prisma.TransactionClient, order: Order, userId: string) {
  const balance = await lockedBalance(tx, userId);
  const assignment = await tx.orderAssignment.findUnique({ where: { orderId_offerAttemptId: { orderId: order.id, offerAttemptId: order.offerAttemptId } } });
  // Legacy assignments already paid at accept. Never invent another charge.
  if (!assignment) {
    const ledger = await tx.transaction.aggregate({ where: { orderId: order.id, balanceId: balance.id, type: { in: ['PAYMENT', 'REFUND'] } }, _sum: { amount: true } });
    const paid = Prisma.Decimal.max(0, new Prisma.Decimal(ledger._sum.amount ?? 0).negated());
    const historical = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
    if (historical.driverId) await tx.orderAssignment.create({ data: { orderId: order.id, driverId: historical.driverId, offerAttemptId: order.offerAttemptId, quotedAmount: paid, fundingState: paid.gt(0) ? 'CAPTURED' : 'UNPRICED', acceptedAt: historical.acceptedAt ?? new Date(), capturedAt: paid.gt(0) ? historical.acceptedAt ?? new Date() : null } });
    return null;
  }
  if (assignment.fundingState === 'UNPRICED') return null;
  if (assignment.fundingState !== 'HELD') throw ApiError.conflict('Средства заказа уже обработаны');
  if (balance.amount.lt(assignment.quotedAmount)) throw ApiError.conflict('Средства заказа недоступны');
  const amount = balance.amount.sub(assignment.quotedAmount);
  await tx.balance.update({ where: { id: balance.id }, data: { amount } });
  await tx.transaction.create({ data: { balanceId: balance.id, orderId: order.id, type: 'PAYMENT', amount: assignment.quotedAmount.negated(), balanceAfter: amount, note: `Заказ #${order.orderNumber}: цена поездки списана при начале` } });
  await tx.orderAssignment.update({ where: { id: assignment.id }, data: { fundingState: 'CAPTURED', capturedAt: new Date() } });
  return walletSummary(tx, { ...balance, amount });
}

export async function releaseOrderQuote(tx: Prisma.TransactionClient, order: Order, userId: string, action: string) {
  const balance = await lockedBalance(tx, userId);
  const assignment = await tx.orderAssignment.findUnique({ where: { orderId_offerAttemptId: { orderId: order.id, offerAttemptId: order.offerAttemptId } } });
  if (assignment) {
    if (!['HELD', 'UNPRICED'].includes(assignment.fundingState)) throw ApiError.conflict('Средства заказа уже обработаны');
    await tx.orderAssignment.update({ where: { id: assignment.id }, data: { fundingState: 'RELEASED', releasedAt: new Date(), endedAt: new Date(), endAction: action } });
    return { wallet: await walletSummary(tx, balance), reason: 'RELEASE' };
  }
  // Old pre-start orders may have a real acceptance debit. Refund the actual
  // net debit, independent of any later quote edit, once under the order lock.
  const ledger = await tx.transaction.aggregate({ where: { orderId: order.id, balanceId: balance.id, type: { in: ['PAYMENT', 'REFUND'] } }, _sum: { amount: true } });
  const paid = new Prisma.Decimal(ledger._sum.amount ?? 0).negated();
  const historical = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
  if (historical.driverId) await tx.orderAssignment.create({ data: { orderId: order.id, driverId: historical.driverId, offerAttemptId: order.offerAttemptId, quotedAmount: Prisma.Decimal.max(0, paid), fundingState: 'RELEASED', acceptedAt: historical.acceptedAt ?? new Date(), capturedAt: paid.gt(0) ? historical.acceptedAt ?? new Date() : null, releasedAt: new Date(), endedAt: new Date(), endAction: action } });
  if (!paid.gt(0)) return { wallet: await walletSummary(tx, balance), reason: 'RELEASE' };
  const amount = balance.amount.add(paid);
  await tx.balance.update({ where: { id: balance.id }, data: { amount } });
  await tx.transaction.create({ data: { balanceId: balance.id, orderId: order.id, type: 'REFUND', amount: paid, balanceAfter: amount, note: `Заказ #${order.orderNumber}: возврат ранее списанной цены` } });
  return { wallet: await walletSummary(tx, { ...balance, amount }), reason: 'REFUND' };
}

export async function acceptedPrice(tx: Prisma.TransactionClient, order: Order) {
  const assignment = await tx.orderAssignment.findUnique({ where: { orderId_offerAttemptId: { orderId: order.id, offerAttemptId: order.offerAttemptId } } });
  if (assignment) return assignment.quotedAmount;
  const paid = await tx.transaction.aggregate({ where: { orderId: order.id, type: 'PAYMENT' }, _sum: { amount: true } });
  return paid._sum.amount?.lt(0) ? paid._sum.amount.negated() : order.priceEstimated;
}
