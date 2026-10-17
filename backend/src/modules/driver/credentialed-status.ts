import { PrismaClient, Prisma } from "@prisma/client";
import { assertShiftControl, lockDeviceSession } from "./shift-ownership";
import { lockedBalance } from "../balance/locked-balance";
const prisma: PrismaClient = require("../../lib/prisma");
const ApiError = require("../../utils/ApiError");
const { assertFreshGps } = require("./gps-eligibility");

// Serialize availability writes with dispatcher credential changes. Checking only
// in HTTP authentication would let an already-running old request restore online.
export async function updateCredentialedStatus(
  driverId: string,
  userId: string,
  credentialVersion: number,
  data: {
    isOnline?: boolean;
    isAvailable?: boolean;
    position?: {
      lat: number;
      lng: number;
      capturedAt: number;
      accuracy?: number;
      heading?: number;
      speed?: number;
    };
  },
  deviceId?: string,
  deviceVersion?: number,
) {
  return prisma.$transaction(async (tx) => {
    await lockDeviceSession(tx, {
      id: driverId,
      userId,
      sessionDeviceId: deviceId,
      sessionDeviceVersion: deviceVersion,
      sessionCredentialVersion: credentialVersion,
    });
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.credentialVersion !== credentialVersion)
      throw ApiError.unauthorized("Данные входа изменены. Войдите снова");
    await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId} FOR UPDATE`;
    const driver = await tx.driver.findUniqueOrThrow({
      where: { id: driverId },
    });
    assertShiftControl(driver, deviceId);
    if (data.isOnline === false)
      await tx.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE driver_id = ${driverId} AND revoked_at IS NULL`;
    let location: Prisma.DriverUpdateInput = {};
    if (data.isOnline === true) {
      if (!driver.isOnline && !data.position)
        throw ApiError.forbidden("Включите GPS и обновите местоположение", {
          code: "GPS_REQUIRED",
        });
      if (data.position) {
        // Validate after the ownership lock so no losing device can overwrite
        // the working phone's location or extend its lease.
        const fix = data.position;
        const now = Date.now();
        if (now - fix.capturedAt >= 60000 || fix.capturedAt - now > 5000)
          throw ApiError.badRequest("GPS устарел. Обновите местоположение", {
            code: "GPS_STALE",
          });
        const recordedAt = new Date(Math.min(now, fix.capturedAt));
        const district =
          await require("../districts/districts.service").findDistrictForGpsPoint(
            fix.lat,
            fix.lng,
          );
        location = {
          lastLat: fix.lat,
          lastLng: fix.lng,
          lastHeading: fix.heading,
          lastSpeed: fix.speed,
          lastLocationAt: recordedAt,
          district: district
            ? { connect: { id: district.id } }
            : { disconnect: true },
        };
        await tx.driverLocation.create({
          data: {
            driverId,
            lat: fix.lat,
            lng: fix.lng,
            heading: fix.heading,
            speed: fix.speed,
            accuracy: fix.accuracy,
            recordedAt,
          },
        });
      } else assertFreshGps(driver);
      const balance = await lockedBalance(tx, userId);
      if (!balance.amount.greaterThan(0))
        throw ApiError.forbidden("Пополните баланс, чтобы выйти на линию");
    }
    // Only a real explicit shift acquisition may make the one off-shift
    // convenience attempt exempt from the next shared cooldown. Merely posting
    // purpose=online to the address endpoint cannot grant this exception.
    if (data.isOnline === true && !driver.isOnline && data.position)
      await tx.driverAddressState.updateMany({
        where: { driverId, purpose: "off-shift" },
        data: { onlineExceptionReady: true },
      });
    const active = await tx.order.findFirst({
      where: { driverId, status: { in: ["ACCEPTED", "WAITING", "STARTED"] } },
      select: { id: true },
    });
    // An active trip always overrides caller-provided availability.
    return tx.driver.update({
      where: { id: driverId },
      data: {
        ...location,
        ...(data.isOnline === true
          ? { shiftDeviceId: deviceId }
          : data.isOnline === false
            ? { shiftDeviceId: null }
            : {}),
        ...(data.isOnline !== undefined ? { isOnline: data.isOnline } : {}),
        isAvailable: active ? false : (data.isAvailable ?? driver.isAvailable),
      },
    });
  });
}
