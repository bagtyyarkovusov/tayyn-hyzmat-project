const prisma = require('../../lib/prisma');
const ApiError = require('../../utils/ApiError');

function afterCursor(sentAt, id) {
  if (!sentAt) return {};
  return id
    ? { OR: [{ sentAt: { gt: sentAt } }, { sentAt, id: { gt: id } }] }
    : { sentAt: { gt: sentAt } };
}
async function beforeCursor(conversation, id) {
  if (!id) return {};
  const cursor = await prisma.message.findFirst({ where: { AND: [conversation, { id }] }, select: { id: true, sentAt: true } });
  if (!cursor) throw ApiError.badRequest('Некорректная отметка сообщения');
  return { OR: [{ sentAt: { lt: cursor.sentAt } }, { sentAt: cursor.sentAt, id: { lt: cursor.id } }] };
}
async function markRead(driverId, conversation, throughMessageId, timeField, idField) {
  let at = new Date();
  if (throughMessageId) {
    const message = await prisma.message.findFirst({ where: { AND: [conversation, { id: throughMessageId }] }, select: { sentAt: true } });
    if (!message) throw ApiError.badRequest('Некорректная отметка сообщения');
    at = message.sentAt;
  }
  await prisma.driver.updateMany({
    where: { id: driverId, OR: [
      { [timeField]: null },
      { [timeField]: { lt: at } },
      ...(throughMessageId ? [{ [timeField]: at, [idField]: { lt: throughMessageId } }] : [])
    ] },
    data: { [timeField]: at, [idField]: throughMessageId ?? null }
  });
}
module.exports = { afterCursor, beforeCursor, markRead };
