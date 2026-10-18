import { Prisma } from '@prisma/client';

/**
 * Read the wallet only after taking its transaction-scoped lock. Monetary
 * callers lock the driver first, then the order if any, then this wallet.
 * The lock remains held through both the amount write and ledger insertion.
 */
export async function lockedBalance(tx: Prisma.TransactionClient, userId: string) {
  await tx.balance.upsert({ where: { userId }, update: {}, create: { userId, amount: 0 } });
  await tx.$queryRaw`SELECT id FROM balances WHERE user_id = ${userId} FOR UPDATE`;
  return tx.balance.findUniqueOrThrow({ where: { userId } });
}

// Only live HELD assignments reduce spendable funds. Captured/released quotes
// remain in history without affecting the wallet again.
export async function walletSummary(tx: Prisma.TransactionClient, balance: { userId: string; amount: Prisma.Decimal; currency?: string }) {
  const held = await tx.orderAssignment.aggregate({ where: { driver: { userId: balance.userId }, fundingState: 'HELD' }, _sum: { quotedAmount: true } });
  const total = new Prisma.Decimal(balance.amount);
  const reserved = new Prisma.Decimal(held._sum.quotedAmount ?? 0);
  return { ...balance, amount: total, total, held: reserved, available: total.sub(reserved) };
}
