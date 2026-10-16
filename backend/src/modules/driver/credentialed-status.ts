import { PrismaClient } from "@prisma/client";
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
    const driver = await tx.driver.findUniqueOrThrow({
      where: { id: driverId },
    });
    if (data.isOnline === false)
      await tx.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE driver_id = ${driverId} AND revoked_at IS NULL`;
    if (data.isOnline === true) assertFreshGps(driver);
    return tx.driver.update({ where: { id: driverId }, data });
  });
}
