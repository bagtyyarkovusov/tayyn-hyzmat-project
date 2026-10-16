import type { Driver, Prisma } from '@prisma/client';
import ApiError from '../../utils/ApiError';

export const GPS_FRESHNESS_MS = 60_000;

export function hasFreshGps(driver: Pick<Driver, 'lastLat' | 'lastLng' | 'lastLocationAt'>, now = Date.now()): boolean {
  if (driver.lastLat === null || driver.lastLng === null || !driver.lastLocationAt) return false;
  const lat = Number(driver.lastLat);
  const lng = Number(driver.lastLng);
  const age = now - driver.lastLocationAt.getTime();
  return Number.isFinite(lat) && lat >= -90 && lat <= 90
    && Number.isFinite(lng) && lng >= -180 && lng <= 180
    && age >= 0 && age < GPS_FRESHNESS_MS;
}

export function assertFreshGps(driver: Driver): void {
  if (!hasFreshGps(driver)) throw ApiError.forbidden('Включите GPS и обновите местоположение', { code: 'GPS_REQUIRED' });
}

export function assertOrderEligibility(driver: Driver): void {
  assertFreshGps(driver);
  if (!driver.isOnline) throw ApiError.forbidden('Выйдите на линию, чтобы принимать заказы', { code: 'DRIVER_OFFLINE' });
}

// Shared by operational counts so stale or future GPS cannot appear as supply.
export function onlineDriverWhere(now = new Date()): Prisma.DriverWhereInput {
  return {
    status: 'APPROVED', user: { status: 'ACTIVE' }, isOnline: true,
    lastLat: { gte: -90, lte: 90 }, lastLng: { gte: -180, lte: 180 },
    lastLocationAt: { gt: new Date(now.getTime() - GPS_FRESHNESS_MS), lte: now }
  };
}
