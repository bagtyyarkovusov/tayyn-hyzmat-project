import { PrismaClient } from "@prisma/client";
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
  data: { isOnline?: boolean; isAvailable?: boolean },
) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.credentialVersion !== credentialVersion)
      throw ApiError.unauthorized("Данные входа изменены. Войдите снова");
    await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId} FOR UPDATE`;
    const driver = await tx.driver.findUniqueOrThrow({
      where: { id: driverId },
    });
    if (data.isOnline === false)
      await tx.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE driver_id = ${driverId} AND revoked_at IS NULL`;
    if (data.isOnline === true) {
      assertFreshGps(driver);
      const balance = await lockedBalance(tx, userId);
      if (!balance.amount.greaterThan(0))
        throw ApiError.forbidden("Пополните баланс, чтобы выйти на линию");
    }
    const active = await tx.order.findFirst({
      where: { driverId, status: { in: ["ACCEPTED", "WAITING", "STARTED"] } },
      select: { id: true },
    });
    // An active trip always overrides caller-provided availability.
    return tx.driver.update({ where: { id: driverId }, data: { ...data, isAvailable: active ? false : (data.isAvailable ?? driver.isAvailable) } });
  });
}
