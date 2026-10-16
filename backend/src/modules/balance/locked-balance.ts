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
