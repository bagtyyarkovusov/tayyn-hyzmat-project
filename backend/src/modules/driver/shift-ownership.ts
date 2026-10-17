import type { Driver, Prisma } from "@prisma/client";
import { hasFreshGps } from "./gps-eligibility";
const ApiError = require("../../utils/ApiError");

// The identity comes from the signed access token, never a caller-supplied body.
export function assertShiftControl(
  driver: Pick<Driver, "isOnline" | "shiftDeviceId">,
  deviceId?: string,
): void {
  if (!deviceId)
    throw ApiError.unauthorized("Войдите снова на этом устройстве");
  if (driver.isOnline && driver.shiftDeviceId !== deviceId)
    throw ApiError.conflict(
      "Смена активна на другом устройстве. Завершите её там перед переключением.",
      { code: "SHIFT_ACTIVE_ON_OTHER_DEVICE" },
    );
}

type Identity = {
  userId: string;
  id: string;
  sessionDeviceId?: string;
  sessionDeviceVersion?: number;
  sessionCredentialVersion?: number;
};
// User -> driver is the common mutation lock order, shared with logout/reset.
export async function lockDeviceSession(
  tx: Prisma.TransactionClient,
  identity: Identity,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM users WHERE id = ${identity.userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: identity.userId } });
  const device =
    identity.sessionDeviceId &&
    (await tx.driverDevice.findUnique({
      where: {
        driverId_deviceId: {
          driverId: identity.id,
          deviceId: identity.sessionDeviceId,
        },
      },
    }));
  if (
    !user ||
    user.status !== "ACTIVE" ||
    user.credentialVersion !== identity.sessionCredentialVersion ||
    !device ||
    device.sessionVersion !== identity.sessionDeviceVersion
  )
    throw ApiError.unauthorized("Сессия устройства завершена. Войдите снова");
  await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${identity.id} FOR UPDATE`;
  await releaseExpiredShift(tx, identity.id);
}

// Caller holds user -> driver locks. Resolve persisted ownership before accepting
// a new GPS upload, so that upload cannot accidentally keep a dead owner's shift.
export async function releaseExpiredShift(
  tx: Prisma.TransactionClient,
  driverId: string,
): Promise<Driver> {
  const driver = await tx.driver.findUniqueOrThrow({ where: { id: driverId } });
  if (!driver.isOnline && !driver.shiftDeviceId) return driver;
  const leases = await tx.$queryRaw<
    Array<{ device_id: string; expires_at: Date }>
  >`SELECT device_id, expires_at FROM native_shift_leases WHERE driver_id = ${driverId} AND revoked_at IS NULL`;
  const lease = leases[0];
  const expired =
    !driver.isOnline ||
    !driver.shiftDeviceId ||
    !hasFreshGps(driver) ||
    Boolean(
      lease &&
      (lease.device_id !== driver.shiftDeviceId ||
        lease.expires_at.getTime() <= Date.now()),
    );
  if (!expired) return driver;
  await tx.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE driver_id = ${driverId} AND revoked_at IS NULL`;
  return tx.driver.update({
    where: { id: driverId },
    data: { isOnline: false, shiftDeviceId: null },
  });
}
