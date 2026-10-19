import { Prisma } from "@prisma/client";
import { lockedBalance, walletSummary } from "../balance/locked-balance";
const ApiError = require("../../utils/ApiError");

type Order = {
  id: string;
  orderNumber: number;
  offerAttemptId: string;
  priceEstimated?: Prisma.Decimal.Value | null;
};

// Callers lock driver, order, then wallet. The quote belongs to this attempt.
export async function debitOrderQuoteOnAcceptance(
  tx: Prisma.TransactionClient,
  order: Order,
  driverId: string,
  userId: string,
) {
  const balance = await lockedBalance(tx, userId);
  const summary = await walletSummary(tx, balance);
  const quote = Prisma.Decimal.max(
    0,
    new Prisma.Decimal(order.priceEstimated ?? 0),
  );
  if (summary.available.lt(quote))
    throw ApiError.forbidden(
      `Недостаточно средств. Доступно ${summary.available.toFixed(2)} TMT`,
    );
  const assignment = await tx.orderAssignment.create({
    data: {
      orderId: order.id,
      driverId,
      offerAttemptId: order.offerAttemptId,
      quotedAmount: quote,
      fundingState: quote.gt(0) ? "CAPTURED" : "UNPRICED",
      capturedAt: quote.gt(0) ? new Date() : null,
    },
  });
  const amount = balance.amount.sub(quote);
  if (quote.gt(0)) {
    await tx.balance.update({ where: { id: balance.id }, data: { amount } });
    await tx.transaction.create({
      data: {
        balanceId: balance.id,
        orderId: order.id,
        assignmentId: assignment.id,
        type: "PAYMENT",
        amount: quote.negated(),
        balanceAfter: amount,
        heldAfter: summary.held,
        note: `Заказ #${order.orderNumber}: цена поездки списана при принятии`,
      },
    });
  }
  return walletSummary(tx, { ...balance, amount });
}

// Refund only a proven original debit, never mutable price metadata or status.
// Unlinked legacy ledger rows are accepted only for a single unambiguous
// assignment. Partial refunds, pending records and conflicting history fail closed.
export async function cancelOrderFunding(
  tx: Prisma.TransactionClient,
  order: Order,
  userId: string,
  outcome: "WITH_REFUND" | "WITHOUT_REFUND",
) {
  const balance = await lockedBalance(tx, userId);
  let assignment = await tx.orderAssignment.findUnique({
    where: {
      orderId_offerAttemptId: {
        orderId: order.id,
        offerAttemptId: order.offerAttemptId,
      },
    },
  });
  const ambiguous = () =>
    ApiError.conflict("История списаний заказа требует сверки диспетчером", {
      code: "LEGACY_FUNDING_AMBIGUOUS",
    });
  if (assignment) {
    const driver = await tx.driver.findUniqueOrThrow({
      where: { id: assignment.driverId },
    });
    if (
      driver.userId !== userId ||
      !["CAPTURED", "UNPRICED"].includes(assignment.fundingState) ||
      assignment.endedAt
    )
      throw ambiguous();
  }
  const linked = assignment
    ? await tx.transaction.findFirst({
        where: { assignmentId: assignment.id, type: "PAYMENT" },
      })
    : null;
  if (
    linked &&
    (linked.balanceId !== balance.id || linked.orderId !== order.id)
  )
    throw ambiguous();
  if (
    !linked &&
    (await tx.orderAssignment.count({
      where: {
        orderId: order.id,
        ...(assignment ? { id: { not: assignment.id } } : {}),
      },
    }))
  )
    throw ambiguous();
  const entries = await tx.transaction.findMany({
    where: {
      type: { in: ["PAYMENT", "REFUND"] },
      status: { not: "FAILED" },
      ...(linked
        ? {
            OR: [
              { assignmentId: assignment!.id },
              { orderId: order.id, assignmentId: null },
            ],
          }
        : { orderId: order.id }),
    },
  });
  if (
    entries.some(
      (entry) =>
        entry.balanceId !== balance.id ||
        entry.orderId !== order.id ||
        entry.status !== "COMPLETED" ||
        entry.currency !== "TMT" ||
        entry.type === "REFUND" ||
        !entry.amount.lt(0),
    ) ||
    entries.length > 1
  )
    throw ambiguous();
  const paid = entries.length
    ? entries[0].amount.negated()
    : new Prisma.Decimal(0);
  if (
    assignment &&
    ((assignment.fundingState === "CAPTURED" &&
      !paid.eq(assignment.quotedAmount)) ||
      (assignment.fundingState === "UNPRICED" && paid.gt(0)))
  )
    throw ambiguous();
  if (!assignment) {
    const historical = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
    });
    if (!historical.driverId) throw ambiguous();
    assignment = await tx.orderAssignment.create({
      data: {
        orderId: order.id,
        driverId: historical.driverId,
        offerAttemptId: order.offerAttemptId,
        quotedAmount: paid,
        fundingState: paid.gt(0) ? "CAPTURED" : "UNPRICED",
        acceptedAt: historical.acceptedAt ?? new Date(),
        capturedAt: paid.gt(0) ? (historical.acceptedAt ?? new Date()) : null,
      },
    });
  }
  const refund = outcome === "WITH_REFUND" ? paid : new Prisma.Decimal(0);
  const recorded = paid.gt(0) ? outcome : "NO_DEBIT";
  const amount = balance.amount.add(refund);
  if (refund.gt(0)) {
    await tx.balance.update({ where: { id: balance.id }, data: { amount } });
    await tx.transaction.create({
      data: {
        balanceId: balance.id,
        orderId: order.id,
        assignmentId: assignment.id,
        type: "REFUND",
        amount: refund,
        balanceAfter: amount,
        note: `Заказ #${order.orderNumber}: возврат списанной цены`,
      },
    });
  }
  await tx.orderAssignment.update({
    where: { id: assignment.id },
    data: {
      fundingState: refund.gt(0) ? "RELEASED" : assignment.fundingState,
      releasedAt: refund.gt(0) ? new Date() : null,
      endedAt: new Date(),
      endAction: `CANCELLED_${recorded}`,
    },
  });
  return {
    wallet: await walletSummary(tx, { ...balance, amount }),
    reason: "REFUND",
    refund,
    outcome: recorded,
    changed: refund.gt(0),
  };
}

export async function acceptedPrice(
  tx: Prisma.TransactionClient,
  order: Order,
) {
  const assignment = await tx.orderAssignment.findUnique({
    where: {
      orderId_offerAttemptId: {
        orderId: order.id,
        offerAttemptId: order.offerAttemptId,
      },
    },
  });
  if (assignment) return assignment.quotedAmount;
  const paid = await tx.transaction.aggregate({
    where: { orderId: order.id, type: "PAYMENT", status: "COMPLETED" },
    _sum: { amount: true },
  });
  return paid._sum.amount?.lt(0)
    ? paid._sum.amount.negated()
    : order.priceEstimated;
}
