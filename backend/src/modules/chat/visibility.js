const prisma = require('../../lib/prisma');

function adminBroadcasts(createdAt) {
  return { isBroadcast: true, sender: { role: 'ADMIN' }, ...(createdAt ? { sentAt: { gte: createdAt } } : {}) };
}
async function driverChatVisibility(userId) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { createdAt: true } });
  const broadcasts = adminBroadcasts(user.createdAt);
  return {
    conversation: { OR: [{ senderId: userId, isBroadcast: false }, { receiverId: userId, isBroadcast: false }, broadcasts] },
    incoming: { OR: [{ receiverId: userId, isBroadcast: false }, broadcasts] }
  };
}
module.exports = { adminBroadcasts, driverChatVisibility };
