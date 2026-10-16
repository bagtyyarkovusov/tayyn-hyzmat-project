import type { Driver } from "./domain";

export function canOfferToDriver(driver: Driver, now: number) {
  const reportedAt = Date.parse(driver.lastLocationAt ?? "");
  return (
    driver.status === "APPROVED" &&
    driver.isOnline &&
    driver.isAvailable &&
    driver.lastLat != null &&
    driver.lastLng != null &&
    Number.isFinite(reportedAt) &&
    now - reportedAt >= 0 &&
    now - reportedAt < 60_000
  );
}
