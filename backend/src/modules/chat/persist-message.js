const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');

// A retry has the same sender-scoped ID and payload. The database unique
// constraint resolves concurrent retries without producing another delivery.
async function persistMessage(data) {
  try {
    return { message: await prisma.message.create({ data }), created: true };
  } catch (error) {
    if (!data.clientMessageId || error.code !== 'P2002') throw error;
    const message = await prisma.message.findFirst({ where: { senderId: data.senderId, clientMessageId: data.clientMessageId } });
    if (!message) throw error;
    if (message.body !== data.body || message.receiverId !== (data.receiverId ?? null) || message.isBroadcast !== data.isBroadcast) {
      throw ApiError.conflict('Идентификатор сообщения уже использован');
    }
    return { message, created: false };
  }
}
module.exports = { persistMessage };
