import { PrismaClient } from "@prisma/client";
const prisma: PrismaClient = require("../../lib/prisma");
const ApiError = require("../../utils/ApiError");
export async function validateCredentialSession(payload: {
  sub: string;
  role: string;
  credentialVersion?: number;
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
}
