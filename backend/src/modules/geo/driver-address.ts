import prisma from "../../lib/prisma";
import { haversineDistanceKm } from "../../utils/geo";
import ApiError from "../../utils/ApiError";
import { z } from "zod";
import {
  geocoderConfig,
  reverseAddress,
  quotaPeriod,
  GeocoderFailure,
} from "./yandex-geocoder";
import { hasFreshGps } from "../driver/gps-eligibility";

export interface AddressActor {
  id: string;
  credentialVersion: number;
  role: string;
  driverId?: string;
  deviceId?: string;
  deviceVersion?: number;
}
const requestSchema = z
  .object({
    purpose: z.enum(["off-shift", "online", "refresh"]),
    position: z
      .object({
        lat: z.number().finite().min(-90).max(90),
        lng: z.number().finite().min(-180).max(180),
        capturedAt: z.number().finite(),
      })
      .strict()
      .optional(),
  })
  .strict();
const COOLDOWN_MS = 300_000;
const PENDING_MS = 10_000;

export async function driverAddress(
  actor: AddressActor,
  driverId: string,
  body: unknown,
) {
  if (actor.role !== "DRIVER" || actor.driverId !== driverId)
    throw ApiError.forbidden();
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) throw ApiError.badRequest("Неверный запрос адреса");
  const { purpose, position: transient } = parsed.data;
  if (
    purpose === "off-shift" &&
    (!transient ||
      Date.now() - transient.capturedAt >= 60_000 ||
      transient.capturedAt - Date.now() > 5_000)
  )
    throw ApiError.badRequest("Нужны свежие координаты GPS");
  if (purpose !== "off-shift" && transient)
    throw ApiError.badRequest("Координаты смены определяются сервером");
  const config = geocoderConfig();
  const reserved = await prisma.$transaction(async (tx) => {
    // Same lock order as logout, blocking and Online. A convenience point is
    // geocoding input only: this path never writes tracking or shift state.
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: actor.id } });
    const device =
      actor.deviceId &&
      (await tx.driverDevice.findUnique({
        where: { driverId_deviceId: { driverId, deviceId: actor.deviceId } },
      }));
    if (
      !user ||
      user.status !== "ACTIVE" ||
      user.credentialVersion !== actor.credentialVersion ||
      !device ||
      device.sessionVersion !== actor.deviceVersion
    )
      throw ApiError.unauthorized("Сессия устройства завершена. Войдите снова");
    await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId} FOR UPDATE`;
    const driver = await tx.driver.findUnique({ where: { id: driverId } });
    if (!driver || driver.userId !== user.id || driver.status !== "APPROVED")
      throw ApiError.forbidden();
    const reply = (reason: string, extra = {}) => ({
      address: null,
      position: null,
      reason,
      ...extra,
    });
    if (purpose === "off-shift" && device.addressConvenienceAt)
      return reply("convenience-consumed", { convenienceConsumed: true });
    if (purpose === "off-shift" && driver.isOnline)
      return reply("on-shift", { convenienceConsumed: false });
    if (purpose !== "off-shift" && !driver.isOnline) return reply("off-shift");
    if (purpose !== "off-shift" && driver.shiftDeviceId !== actor.deviceId)
      return reply("other-shift-device");
    const position =
      purpose === "off-shift"
        ? { lat: transient!.lat, lng: transient!.lng }
        : hasFreshGps(driver)
          ? { lat: Number(driver.lastLat), lng: Number(driver.lastLng) }
          : null;
    if (!position) return reply("gps-unavailable");
    const fallback = (reason: string, extra = {}) =>
      reply(reason, {
        position,
        ...(purpose === "off-shift" ? { convenienceConsumed: false } : {}),
        ...extra,
      });
    if (!config) return fallback("unconfigured");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(58720314)`;
    const now = new Date();
    const previous = await tx.driverAddressState.findUnique({
      where: { driverId },
    });
    if (previous?.pendingUntil && previous.pendingUntil > now)
      return fallback("pending", {
        retryAt: previous.pendingUntil.toISOString(),
      });
    const onlineException =
      purpose !== "off-shift" &&
      previous?.purpose === "off-shift" &&
      previous.onlineExceptionReady;
    // A real shift acquisition grants one lookup even if the app reloads and
    // resumes with refresh instead of its original Online event. The persisted
    // grant is consumed by reservation, never by merely naming a purpose.
    if (
      !onlineException &&
      purpose !== "off-shift" &&
      previous?.address &&
      previous.cacheUntil &&
      previous.cacheUntil > now &&
      now.getTime() - previous.attemptedAt.getTime() < COOLDOWN_MS &&
      config.cacheSeconds > 0 &&
      haversineDistanceKm(position, {
        lat: Number(previous.sourceLat),
        lng: Number(previous.sourceLng),
      }) < 0.15
    )
      return {
        address: previous.address,
        // Retain the provider's original source point. Returning today's GPS
        // would re-anchor an old label and defeat the client's 150 m guard.
        position: {
          lat: Number(previous.sourceLat),
          lng: Number(previous.sourceLng),
        },
        resolvedAt: previous.attemptedAt.toISOString(),
        retryAt: new Date(
          previous.attemptedAt.getTime() + COOLDOWN_MS,
        ).toISOString(),
        reason: "cached",
      };
    if (
      !onlineException &&
      previous &&
      now.getTime() - previous.attemptedAt.getTime() < COOLDOWN_MS
    )
      return fallback("limited", {
        retryAt: new Date(
          previous.attemptedAt.getTime() + COOLDOWN_MS,
        ).toISOString(),
      });
    const period = quotaPeriod(now, config.timezone, config.resetHour);
    let budget = await tx.geocoderBudget.upsert({
      where: { provider: "yandex" },
      create: { provider: "yandex", period },
      update: {},
    });
    if (period > budget.period)
      budget = await tx.geocoderBudget.update({
        where: { provider: "yandex" },
        data: { period, attempts: 0 },
      });
    if (budget.blockedUntil && budget.blockedUntil > now)
      return fallback("provider-backoff", {
        retryAt: budget.blockedUntil.toISOString(),
      });
    if (budget.attempts >= Math.floor(config.dailyLimit * 0.8))
      return fallback("budget-exhausted");
    await tx.geocoderBudget.update({
      where: { provider: "yandex" },
      data: { attempts: { increment: 1 } },
    });
    const state = {
      attemptedAt: now,
      sourceLat: position.lat,
      sourceLng: position.lng,
      address: null,
      cacheUntil: null,
      purpose: purpose === "off-shift" ? "off-shift" : "shift",
      onlineExceptionReady: false,
      pendingUntil: new Date(now.getTime() + PENDING_MS),
    };
    await tx.driverAddressState.upsert({
      where: { driverId },
      create: { driverId, ...state },
      update: state,
    });
    if (purpose === "off-shift")
      await tx.driverDevice.update({
        where: { id: device.id },
        data: { addressConvenienceAt: now },
      });
    return {
      attemptedAt: now,
      position,
      convenienceConsumed: purpose === "off-shift",
    };
  });
  if (!("attemptedAt" in reserved) || !reserved.attemptedAt) return reserved;
  // Config was checked before reservation. Only an admitted attempt reaches here.
  const position = reserved.position;
  const retryAt = new Date(
    reserved.attemptedAt.getTime() + COOLDOWN_MS,
  ).toISOString();
  try {
    const address = await reverseAddress(
      position,
      config!.key,
      config!.referer,
    );
    // A delayed provider result cannot overwrite the next admitted source point.
    await prisma.driverAddressState.updateMany({
      where: { driverId, attemptedAt: reserved.attemptedAt },
      data: {
        pendingUntil: null,
        ...(address && config!.cacheSeconds > 0
          ? {
              address,
              cacheUntil: new Date(Date.now() + config!.cacheSeconds * 1000),
            }
          : {}),
      },
    });
    return {
      address,
      resolvedAt: reserved.attemptedAt.toISOString(),
      position,
      reason: "resolved",
      retryAt,
      convenienceConsumed: reserved.convenienceConsumed,
    };
  } catch (error) {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(58720314)`;
      const budget = await tx.geocoderBudget.findUniqueOrThrow({
        where: { provider: "yandex" },
      });
      const failures = Math.min(budget.failures + 1, 10);
      const delay =
        error instanceof GeocoderFailure && error.status === 403
          ? 3_600_000
          : Math.min(30_000 * 2 ** (failures - 1), COOLDOWN_MS);
      const until = new Date(Date.now() + delay);
      await tx.geocoderBudget.update({
        where: { provider: "yandex" },
        data: {
          failures,
          blockedUntil:
            budget.blockedUntil && budget.blockedUntil > until
              ? budget.blockedUntil
              : until,
        },
      });
      await tx.driverAddressState.updateMany({
        where: { driverId, attemptedAt: reserved.attemptedAt },
        data: { pendingUntil: null },
      });
    });
    return {
      address: null,
      position,
      reason: "provider-unavailable",
      retryAt,
      convenienceConsumed: reserved.convenienceConsumed,
    };
  }
}

// Expired licensed cache payloads are erased independently of future demand.
export async function clearExpiredAddressCache() {
  await prisma.driverAddressState.updateMany({
    where: { cacheUntil: { lte: new Date() } },
    data: { address: null, cacheUntil: null },
  });
}
