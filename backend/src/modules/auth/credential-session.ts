import { PrismaClient } from "@prisma/client";
const prisma: PrismaClient = require("../../lib/prisma");
const ApiError = require("../../utils/ApiError");
export async function validateCredentialSession(payload: {
  sub: string;
  role: string;
  credentialVersion?: number;
  deviceId?: string;
  deviceVersion?: number;
}) {
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { credentialVersion: true, role: true, status: true },
  });
  // Tokens issued before the additive migration represent version zero.
  if (
    !user ||
    user.status !== "ACTIVE" ||
    user.role !== payload.role ||
    user.credentialVersion !== (payload.credentialVersion ?? 0)
  )
    throw ApiError.unauthorized("Данные входа изменены. Войдите снова");
  if (payload.role === "DRIVER") {
    if (!payload.deviceId)
      throw ApiError.unauthorized("Войдите снова на этом устройстве");
    const driver = await prisma.driver.findUnique({
      where: { userId: payload.sub },
    });
    const device =
      driver &&
      (await prisma.driverDevice.findUnique({
        where: {
          driverId_deviceId: {
            driverId: driver.id,
            deviceId: payload.deviceId,
          },
        },
      }));
    if (!device || device.sessionVersion !== payload.deviceVersion)
      throw ApiError.unauthorized("Сессия устройства завершена. Войдите снова");
  }
}
