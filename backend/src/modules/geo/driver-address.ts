import prisma from '../../lib/prisma';
import { haversineDistanceKm } from '../../utils/geo';
import ApiError from '../../utils/ApiError';
import {
  geocoderConfig,
  reverseAddress,
  quotaPeriod,
  GeocoderFailure,
} from './yandex-geocoder';
import { hasFreshGps } from '../driver/gps-eligibility';

export interface AddressActor {
  role: string;
  driverId?: string;
}
export async function driverAddress(actor: AddressActor, driverId: string) {
  if (
    actor.role !== 'ADMIN' &&
    (actor.role !== 'DRIVER' || actor.driverId !== driverId)
  ) {
    throw ApiError.forbidden();
  }
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    include: { user: true },
  });
  if (!driver) throw ApiError.notFound('Водитель не найден');
  if (driver.status !== 'APPROVED' || driver.user.status !== 'ACTIVE')
    throw ApiError.forbidden();
  const position = hasFreshGps(driver)
    ? { lat: Number(driver.lastLat), lng: Number(driver.lastLng) }
    : null;
  if (!position) return { address: null, position, reason: 'gps-unavailable' };
  const config = geocoderConfig();
  if (!config) return { address: null, position, reason: 'unconfigured' };
  const reserved = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(58720314)`;
    const now = new Date();
    const period = quotaPeriod(now, config.timezone, config.resetHour);
    let budget = await tx.geocoderBudget.upsert({
      where: { provider: 'yandex' },
      create: { provider: 'yandex', period },
      update: {},
    });
    if (period > budget.period)
      budget = await tx.geocoderBudget.update({
        where: { provider: 'yandex' },
        data: { period, attempts: 0 },
      });
    if (budget.blockedUntil && budget.blockedUntil > now)
      return 'provider-backoff' as const;
    const previous = await tx.driverAddressState.findUnique({
      where: { driverId },
    });
    if (
      previous?.address &&
      previous.cacheUntil &&
      previous.cacheUntil > now &&
      config.cacheSeconds > 0 &&
      haversineDistanceKm(position, {
        lat: Number(previous.sourceLat),
        lng: Number(previous.sourceLng),
      }) < 0.15
    )
      return { address: previous.address } as const;
    if (
      previous &&
      (now.getTime() - previous.attemptedAt.getTime() < 300_000 ||
        haversineDistanceKm(position, {
          lat: Number(previous.sourceLat),
          lng: Number(previous.sourceLng),
        }) < 0.15)
    )
      return 'limited' as const;
    if (budget.attempts >= Math.floor(config.dailyLimit * 0.8))
      return 'budget-exhausted' as const;
    await tx.geocoderBudget.update({
      where: { provider: 'yandex' },
      data: { attempts: { increment: 1 } },
    });
    await tx.driverAddressState.upsert({
      where: { driverId },
      create: {
        driverId,
        attemptedAt: now,
        sourceLat: position.lat,
        sourceLng: position.lng,
      },
      update: {
        attemptedAt: now,
        sourceLat: position.lat,
        sourceLng: position.lng,
        address: null,
        cacheUntil: null,
      },
    });
    return 'reserved' as const;
  });
  if (typeof reserved === 'object')
    return { address: reserved.address, position, reason: 'cached' };
  if (reserved !== 'reserved')
    return { address: null, position, reason: reserved };
  try {
    const address = await reverseAddress(position, config.key);
    if (address && config.cacheSeconds > 0)
      await prisma.driverAddressState.update({
        where: { driverId },
        data: {
          address,
          cacheUntil: new Date(Date.now() + config.cacheSeconds * 1000),
        },
      });
    // A success must not clear a concurrent failure/circuit breaker.
    return { address, position, reason: 'resolved' };
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(58720314)`;
      const budget = await tx.geocoderBudget.findUniqueOrThrow({
        where: { provider: 'yandex' },
      });
      const failures = Math.min(budget.failures + 1, 10);
      const delay =
        error instanceof GeocoderFailure && error.status === 403
          ? 3_600_000
          : Math.min(30_000 * 2 ** (failures - 1), 300_000);
      const until = new Date(Date.now() + delay);
      await tx.geocoderBudget.update({
        where: { provider: 'yandex' },
        data: {
          failures,
          blockedUntil:
            budget.blockedUntil && budget.blockedUntil > until
              ? budget.blockedUntil
              : until,
        },
      });
    });
    return { address: null, position, reason: 'provider-unavailable' };
  }
}

// Expired licensed cache payloads are erased independently of future driver demand.
// Limit/budget metadata contains our GPS data, not provider address content.
export async function clearExpiredAddressCache() {
  await prisma.driverAddressState.updateMany({
    where: { cacheUntil: { lte: new Date() } },
    data: { address: null, cacheUntil: null },
  });
}
