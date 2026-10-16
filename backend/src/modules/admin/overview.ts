import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { onlineDriverWhere } from '../driver/gps-eligibility';

interface CompletedTripValues {
  completedTrips: number;
  pricedCompletedTrips: number;
  completedTripValue: string;
  averageCompletedTripValue: string;
}

// Operational snapshot, not a shift report or payment/earnings ledger.
export async function getOverview() {
  const [totalDrivers, onlineDrivers, pendingDrivers, activeOrders, completed] = await prisma.$transaction([
    prisma.driver.count(),
    prisma.driver.count({ where: onlineDriverWhere() }),
    prisma.driver.count({ where: { status: 'PENDING' } }),
    prisma.order.count({ where: { status: { in: ['NEW', 'ACCEPTED', 'WAITING', 'STARTED'] } } }),
    prisma.$queryRaw<CompletedTripValues[]>`
      SELECT COUNT(*)::int AS "completedTrips",
             COUNT(COALESCE(price_final, price_estimated))::int AS "pricedCompletedTrips",
             COALESCE(SUM(COALESCE(price_final, price_estimated)), 0)::numeric(20,2)::text AS "completedTripValue",
             COALESCE(AVG(COALESCE(price_final, price_estimated)), 0)::numeric(20,2)::text AS "averageCompletedTripValue"
      FROM orders WHERE status = 'COMPLETED'
    `
  ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return { totalDrivers, onlineDrivers, pendingDrivers, activeOrders, ...completed[0] };
}
