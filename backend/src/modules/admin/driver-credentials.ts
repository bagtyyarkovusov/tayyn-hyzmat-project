import { PrismaClient, Prisma } from "@prisma/client";
const prisma: PrismaClient = require("../../lib/prisma");
const ApiError = require("../../utils/ApiError");

export async function updateDriverProfile(
  id: string,
  input: { fullName: string; phone: string },
) {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const driver = await tx.driver.findUnique({ where: { id } });
      if (!driver) throw ApiError.notFound("Водитель не найден");
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${driver.userId} FOR UPDATE`;
      const previous = await tx.user.findUniqueOrThrow({
        where: { id: driver.userId },
      });
      const changed = previous.phone !== input.phone;
      const user = await tx.user.update({
        where: { id: driver.userId },
        data: {
          ...input,
          ...(changed ? { credentialVersion: { increment: 1 } } : {}),
        },
        select: { id: true, fullName: true, phone: true },
      });
      if (changed) {
        await tx.refreshToken.updateMany({
          where: { userId: driver.userId },
          data: { revokedAt: new Date(0) },
        });
        await tx.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE driver_id = ${id} AND revoked_at IS NULL`;
        await tx.driver.update({ where: { id }, data: { isOnline: false } });
      }
      return { id: driver.id, user, changed };
    });
    if (result.changed) await disconnectRevokedSessions(id);
    return { id: result.id, user: result.user };
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    )
      throw ApiError.conflict("Этот номер телефона уже используется");
    throw error;
  }
}

async function disconnectRevokedSessions(driverId: string) {
  const { getIO } = require("../../lib/socket");
  const rooms = require("../../sockets/rooms");
  const sockets = await getIO().in(rooms.driver(driverId)).fetchSockets();
  const driver = await prisma.driver.findUniqueOrThrow({
    where: { id: driverId },
    include: { user: true },
  });
  for (const socket of sockets) {
    if (
      (socket.data.credentials?.credentialVersion ?? 0) !==
      driver.user.credentialVersion
    ) {
      socket.emit("session:revoked", {
        message: "Данные входа изменены. Войдите снова",
      });
      socket.disconnect(true);
    }
  }
  getIO().to(rooms.admins()).emit("driver:updated", { driverId });
  await require("../districts/districts.service").broadcastDistrictStats();
}

export async function resetDriverPassword(id: string, password: string) {
  const { hashPassword } = require("../../utils/password");
  const passwordHash: string = await hashPassword(password);
  await prisma.$transaction(async (tx) => {
    const driver = await tx.driver.findUnique({ where: { id } });
    if (!driver) throw ApiError.notFound("Водитель не найден");
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${driver.userId} FOR UPDATE`;
    await tx.user.update({
      where: { id: driver.userId },
      data: { passwordHash, credentialVersion: { increment: 1 } },
    });
    await tx.refreshToken.updateMany({
      where: { userId: driver.userId },
      data: { revokedAt: new Date(0) },
    });
    await tx.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE driver_id = ${id} AND revoked_at IS NULL`;
    await tx.driver.update({ where: { id }, data: { isOnline: false } });
  });
  await disconnectRevokedSessions(id);
  return { message: "Пароль изменён. Водителю нужно войти снова" };
}
