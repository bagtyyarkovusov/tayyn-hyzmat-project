// Display eligibility only. The API rechecks the locked wallet when accepting.
export function canFundOrder(
  balanceAmount: number | string | null | undefined,
  priceEstimated: number | string | null | undefined,
) {
  const balance = Number(balanceAmount ?? 0);
  const price = Number(priceEstimated ?? 0);
  return (
    Number.isFinite(balance) &&
    balance > 0 &&
    Number.isFinite(price) &&
    balance >= Math.max(price, 0)
  );
}
