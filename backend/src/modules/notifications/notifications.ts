import { createHash, randomBytes } from 'node:crypto';
import type { NotificationDelivery, NotificationInstallation, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import ApiError from '../../utils/ApiError';
import { getIO } from '../../lib/socket';
import rooms from '../../sockets/rooms';
import { hasFreshGps } from '../driver/gps-eligibility';
import { lockDeviceSession } from '../driver/shift-ownership';
import * as fcm from './fcm';

export type Event = { id: string; channel: 'chat' | 'orders'; title: string; body: string; expiresAt: string; orderId?: string; messageId?: string };
type CanonicalDelivery = Pick<NotificationDelivery, 'eventId' | 'resourceId' | 'channel' | 'expiresAt' | 'cancelledAt' | 'invalidatedAt'>;
type Session = { id: string; userId: string; sessionDeviceId?: string; sessionDeviceVersion?: number; sessionCredentialVersion?: number };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const FALLBACK_MS = 3000;
const CHAT_LIFETIME_MS = 24 * 60 * 60 * 1000;
let processing = false;

async function ensureInstallation(tx: Prisma.TransactionClient, driver: Session) {
  if (!driver.sessionDeviceId || driver.sessionDeviceVersion === undefined || driver.sessionCredentialVersion === undefined) throw ApiError.unauthorized();
  // Serialize against logout/revocation/credential changes. Rechecking only
  // the middleware's earlier snapshot could rotate a replacement session's
  // capability from an old in-flight request.
  await lockDeviceSession(tx, driver);
  const current = await tx.driver.findUnique({ where: { id: driver.id } });
  if (!current || current.status !== 'APPROVED') throw ApiError.forbidden('Доступ запрещён');
  const where = { driverId_deviceId: { driverId: driver.id, deviceId: driver.sessionDeviceId } };
  const row = await tx.notificationInstallation.upsert({ where,
    create: { driverId: driver.id, deviceId: driver.sessionDeviceId, credentialVersion: driver.sessionCredentialVersion, deviceVersion: driver.sessionDeviceVersion }, update: {} });
  if (row.credentialVersion === driver.sessionCredentialVersion && row.deviceVersion === driver.sessionDeviceVersion) return row;
  return tx.notificationInstallation.update({ where: { id: row.id }, data: { credentialVersion: driver.sessionCredentialVersion, deviceVersion: driver.sessionDeviceVersion, token: null, secretHash: null, coordinatorEnabled: false } });
}
function publicSettings(row: NotificationInstallation) {
  return { installationId: row.id, enabled: row.enabled, registered: Boolean(row.token), transportConfigured: fcm.configured(), coordinatorEnabled: row.coordinatorEnabled && fcm.configured() };
}
export async function settings(driver: Session) { return prisma.$transaction(async tx => publicSettings(await ensureInstallation(tx, driver))); }
export async function setEnabled(driver: Session, enabled: boolean) {
  return prisma.$transaction(async tx => {
    const row = await ensureInstallation(tx, driver);
    return publicSettings(await tx.notificationInstallation.update({ where: { id: row.id }, data: { enabled } }));
  });
}
export async function register(driver: Session, token: string | null, enabled: boolean) {
  const notificationToken = randomBytes(32).toString('base64url');
  const updated = await prisma.$transaction(async tx => {
    const row = await ensureInstallation(tx, driver);
    if (token) await tx.notificationInstallation.updateMany({ where: { token, id: { not: row.id } }, data: { token: null, secretHash: null, coordinatorEnabled: false } });
    return tx.notificationInstallation.update({ where: { id: row.id }, data: { token, enabled, secretHash: digest(notificationToken), coordinatorEnabled: Boolean(token) && fcm.configured() } });
  });
  return { ...publicSettings(updated), notificationToken };
}
async function liveContext(installation: NotificationInstallation) {
  const driver = await prisma.driver.findUnique({ where: { id: installation.driverId }, include: { user: { include: { balance: true } } } });
  if (!driver || driver.status !== 'APPROVED' || driver.user.status !== 'ACTIVE' || driver.user.credentialVersion !== installation.credentialVersion) return null;
  const device = await prisma.driverDevice.findUnique({ where: { driverId_deviceId: { driverId: driver.id, deviceId: installation.deviceId } } });
  if (!device || device.sessionVersion !== installation.deviceVersion) return null;
  const session = await prisma.refreshToken.findFirst({ where: { userId: driver.userId, deviceId: installation.deviceId, deviceVersion: installation.deviceVersion, credentialVersion: installation.credentialVersion, revokedAt: null, expiresAt: { gt: new Date() } } });
  return session ? driver : null;
}
async function capability(token: string) {
  const row = await prisma.notificationInstallation.findUnique({ where: { secretHash: digest(token) } });
  if (!row || !(await liveContext(row))) throw ApiError.unauthorized('Вход на устройстве завершён');
  return row;
}
async function canonical(row: NotificationInstallation, delivery: CanonicalDelivery): Promise<Event | null> {
  if (!row.enabled || delivery.cancelledAt || delivery.invalidatedAt || delivery.expiresAt.getTime() <= Date.now()) return null;
  const driver = await liveContext(row);
  if (!driver) return null;
  if (delivery.channel === 'chat') {
    const message = await prisma.message.findUnique({ where: { id: delivery.resourceId } });
    if (!message || (!message.isBroadcast && message.receiverId !== driver.userId) || message.senderId === driver.userId) return null;
    const readAt = driver.lastChatReadAt;
    if (readAt && (message.sentAt < readAt || (message.sentAt.getTime() === readAt.getTime() && (!driver.lastChatReadMessageId || message.id <= driver.lastChatReadMessageId)))) return null;
    return { id: delivery.eventId, channel: 'chat', title: 'Сообщение диспетчера', body: message.body, messageId: message.id, expiresAt: delivery.expiresAt.toISOString() };
  }
  if (!driver.isOnline || !hasFreshGps(driver) || !driver.isAvailable || driver.shiftDeviceId !== row.deviceId || Number(driver.user.balance?.amount ?? 0) <= 0) return null;
  const active = await prisma.order.findFirst({ where: { driverId: driver.id, status: { in: ['ACCEPTED', 'WAITING', 'STARTED'] } }, select: { id: true } });
  const order = await prisma.order.findUnique({ where: { id: delivery.resourceId } });
  if (active || !order || order.status !== 'NEW' || order.driverId || order.privateOfferStoppedAt) return null;
  if (delivery.eventId.startsWith('private:')) {
    if (order.privateOfferDriverId !== driver.id || order.privateOfferExpiresAt?.toISOString() !== delivery.expiresAt.toISOString()) return null;
  } else if (order.privateOfferDriverId || order.districtId !== driver.districtId || order.publicRegionOnlyUntil?.toISOString() !== delivery.expiresAt.toISOString()) return null;
  return { id: delivery.eventId, channel: 'orders', title: 'Новый заказ', body: delivery.eventId.startsWith('private:') ? 'Личное предложение. Откройте приложение.' : 'Доступен заказ. Откройте приложение.', orderId: order.id, expiresAt: delivery.expiresAt.toISOString() };
}
export async function verify(token: string, eventId: string) {
  const row = await capability(token);
  const delivery = await prisma.notificationDelivery.findUnique({ where: { installationId_eventId: { installationId: row.id, eventId } } });
  // An old native-shift tick may know an event before this installation
  // registers with the coordinator. Resolve only our stable ID formats and
  // still apply exactly the same canonical ownership/read/expiry checks.
  let candidate: CanonicalDelivery | null = delivery;
  if (!candidate) {
    const parts = eventId.split(':');
    const resourceId = parts[1];
    if (parts[0] === 'chat' && parts.length === 2) {
      const message = await prisma.message.findUnique({ where: { id: resourceId }, select: { sentAt: true } });
      if (message) candidate = { eventId, resourceId, channel: 'chat', expiresAt: new Date(message.sentAt.getTime() + CHAT_LIFETIME_MS), cancelledAt: null, invalidatedAt: null };
    } else if ((parts[0] === 'order' || parts[0] === 'private') && resourceId) {
      const order = await prisma.order.findUnique({ where: { id: resourceId }, select: { publicRegionOnlyUntil: true, privateOfferExpiresAt: true } });
      const expiresAt = parts[0] === 'private' ? order?.privateOfferExpiresAt : order?.publicRegionOnlyUntil;
      const expectedId = expiresAt && (parts[0] === 'private' ? `private:${resourceId}:${expiresAt.toISOString()}` : `order:${resourceId}`);
      if (expiresAt && eventId === expectedId) candidate = { eventId, resourceId, channel: 'orders', expiresAt, cancelledAt: null, invalidatedAt: null };
    }
  }
  return { event: candidate ? await canonical(row, candidate) : null, serverTime: new Date().toISOString() };
}
async function acknowledge(row: NotificationInstallation, eventId: string) {
  await prisma.notificationDelivery.updateMany({ where: { installationId: row.id, eventId }, data: { acknowledgedAt: new Date() } });
}
export async function ackSession(driver: Session, eventId: string) {
  await prisma.$transaction(async tx => {
    const row = await ensureInstallation(tx, driver);
    await tx.notificationDelivery.updateMany({ where: { installationId: row.id, eventId }, data: { acknowledgedAt: new Date() } });
  });
}
export async function ackNative(token: string, eventId: string) { await acknowledge(await capability(token), eventId); }
export async function rotateToken(secret: string, token: string) {
  const row = await capability(secret);
  const owner = await prisma.driver.findUnique({ where: { id: row.driverId }, select: { userId: true } });
  if (!owner) throw ApiError.unauthorized('Вход на устройстве завершён');
  await prisma.$transaction(async tx => {
    // Logout, password reset and a replacement registration all use this
    // user -> driver lock order. Recheck the capability while holding it so
    // an old in-flight onNewToken request cannot overwrite the new session's
    // FCM token or coordinator secret.
    await lockDeviceSession(tx, {
      id: row.driverId,
      userId: owner.userId,
      sessionDeviceId: row.deviceId,
      sessionDeviceVersion: row.deviceVersion,
      sessionCredentialVersion: row.credentialVersion
    });
    const current = await tx.notificationInstallation.findUnique({ where: { id: row.id } });
    if (!current || current.secretHash !== digest(secret) || current.deviceVersion !== row.deviceVersion || current.credentialVersion !== row.credentialVersion) {
      throw ApiError.unauthorized('Вход на устройстве завершён');
    }
    await tx.notificationInstallation.updateMany({ where: { token, id: { not: row.id } }, data: { token: null, secretHash: null, coordinatorEnabled: false } });
    await tx.notificationInstallation.update({ where: { id: row.id }, data: { token, coordinatorEnabled: fcm.configured() } });
  });
}
// Called inside the message/order transaction; no sockets or remote services.
export async function enqueueChat(tx: Prisma.TransactionClient, message: { id: string; receiverId: string | null; isBroadcast: boolean; senderId: string | null; sentAt: Date }) {
  const installations = await tx.notificationInstallation.findMany({ where: { enabled: true, driver: { userId: message.isBroadcast ? { not: message.senderId ?? '' } : message.receiverId ?? '__none__' } } });
  const expiresAt = new Date(message.sentAt.getTime() + CHAT_LIFETIME_MS);
  if (installations.length) await tx.notificationDelivery.createMany({ data: installations.map(row => ({ installationId: row.id, eventId: `chat:${message.id}`, channel: 'chat', resourceId: message.id, expiresAt, notBefore: new Date(Date.now() + FALLBACK_MS) })), skipDuplicates: true });
}
export async function enqueueOrder(tx: Prisma.TransactionClient, order: { id: string; districtId: string | null; privateOfferDriverId: string | null; privateOfferExpiresAt: Date | null; publicRegionOnlyUntil: Date | null }) {
  const expiresAt = order.privateOfferExpiresAt ?? order.publicRegionOnlyUntil;
  if (!expiresAt) return;
  const installations = await tx.notificationInstallation.findMany({ where: { enabled: true, driver: order.privateOfferDriverId ? { id: order.privateOfferDriverId } : { districtId: order.districtId } } });
  const eventId = order.privateOfferExpiresAt ? `private:${order.id}:${expiresAt.toISOString()}` : `order:${order.id}`;
  if (installations.length) await tx.notificationDelivery.createMany({ data: installations.map(row => ({ installationId: row.id, eventId, channel: 'orders', resourceId: order.id, expiresAt, notBefore: new Date(Date.now() + FALLBACK_MS) })), skipDuplicates: true });
}
// Persist invalidation with the order mutation. Sending the same opaque ID
// wakes closed Android installations; canonical verification now returns null
// and the native renderer removes the old notification without another alert.
export async function invalidateOrder(tx: Prisma.TransactionClient, orderId: string) {
  await tx.notificationDelivery.updateMany({ where: { channel: 'orders', resourceId: orderId, invalidatedAt: null }, data: { invalidatedAt: new Date(), acknowledgedAt: new Date(), notBefore: new Date() } });
}
export async function publishPending(): Promise<void> {
  const deliveries = await prisma.notificationDelivery.findMany({ where: { sentAt: null, socketSentAt: null, cancelledAt: null, acknowledgedAt: null, expiresAt: { gt: new Date() }, createdAt: { gt: new Date(Date.now() - 30_000) } }, include: { installation: true }, take: 200 });
  const io = getIO();
  for (const delivery of deliveries) {
    const event = await canonical(delivery.installation, delivery);
    if (!event) continue;
    const sockets = await io.in(rooms.driver(delivery.installation.driverId)).fetchSockets();
    const matching = sockets.filter((socket: any) => socket.data.credentials?.deviceId === delivery.installation.deviceId);
    if (matching.length) {
      // Claim the foreground leg once. The client immediately acknowledges;
      // otherwise processPending sends the same stable event ID through FCM
      // after the three-second grace period. This avoids a one-second socket
      // loop producing duplicate banners/toasts.
      const claimed = await prisma.notificationDelivery.updateMany({ where: { id: delivery.id, socketSentAt: null, acknowledgedAt: null, cancelledAt: null }, data: { socketSentAt: new Date() } });
      if (claimed.count) for (const socket of matching) socket.emit('notification:event', { installationId: delivery.installation.id, event });
    }
  }
}
export function wake(): void {
  void publishPending().catch(() => {});
}

// Deliveries are an operational outbox, not an indefinite message archive.
// Keep a short audit window after expiry while preventing a busy fleet from
// growing this table without bound.
export async function pruneExpired(): Promise<void> {
  await prisma.notificationDelivery.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - CHAT_LIFETIME_MS) } } });
}
// A short DB claim permits multiple workers. Stable IDs make a retry safe even
// if the process dies after FCM accepts the request but before sentAt commits.
export async function processPending(): Promise<void> {
  if (processing || !fcm.configured()) return;
  processing = true;
  try {
    const invalidations = await prisma.notificationDelivery.findMany({ where: { invalidatedAt: { not: null }, invalidationSentAt: null, notBefore: { lte: new Date() }, OR: [{ claimedUntil: null }, { claimedUntil: { lte: new Date() } }] }, take: 50 });
    for (const delivery of invalidations) {
      const claimed = await prisma.notificationDelivery.updateMany({ where: { id: delivery.id, invalidationSentAt: null, OR: [{ claimedUntil: null }, { claimedUntil: { lte: new Date() } }] }, data: { claimedUntil: new Date(Date.now() + 30_000) } });
      if (!claimed.count) continue;
      const row = await prisma.notificationInstallation.findUnique({ where: { id: delivery.installationId } });
      try {
        if (row?.token && (delivery.sentAt || delivery.socketSentAt) && await liveContext(row)) await fcm.send(row.token, delivery.eventId, new Date(Date.now() + 5 * 60_000));
        await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { invalidationSentAt: new Date(), claimedUntil: null } });
      } catch (error) {
        if (error instanceof fcm.FcmFailure && error.invalidToken && row?.token) {
          await prisma.notificationInstallation.updateMany({ where: { id: row.id, token: row.token }, data: { token: null, coordinatorEnabled: false } });
          await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { invalidationSentAt: new Date(), claimedUntil: null } });
        } else {
          await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { claimedUntil: null, notBefore: new Date(Date.now() + 10_000) } });
        }
      }
    }
    const now = new Date();
    const rows = await prisma.notificationDelivery.findMany({ where: { acknowledgedAt: null, cancelledAt: null, notBefore: { lte: now }, expiresAt: { gt: now }, OR: [{ claimedUntil: null }, { claimedUntil: { lte: now } }] }, include: { installation: true }, take: 50, orderBy: { notBefore: 'asc' } });
    for (const delivery of rows) {
      const claimed = await prisma.notificationDelivery.updateMany({ where: { id: delivery.id, acknowledgedAt: null, cancelledAt: null, notBefore: { lte: new Date() }, OR: [{ claimedUntil: null }, { claimedUntil: { lte: new Date() } }] }, data: { claimedUntil: new Date(Date.now() + 30_000), attempts: { increment: 1 } } });
      if (!claimed.count) continue;
      // A foreground acknowledgement can arrive while the worker claims a
      // batch. Re-read the durable row immediately before transport work.
      const current = await prisma.notificationDelivery.findUnique({ where: { id: delivery.id } });
      if (!current || current.acknowledgedAt || current.cancelledAt) {
        await prisma.notificationDelivery.updateMany({ where: { id: delivery.id }, data: { claimedUntil: null } });
        continue;
      }
      const row = await prisma.notificationInstallation.findUnique({ where: { id: delivery.installationId } });
      const event = row && await canonical(row, current);
      if (!event || !row?.token) {
        await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { cancelledAt: new Date(), claimedUntil: null } });
        continue;
      }
      try {
        const sent = await fcm.send(row.token, event.id, delivery.expiresAt);
        // FCM acceptance is not an application acknowledgement: Android may
        // receive the wake-up while the canonical endpoint is unavailable.
        // Retry the same opaque ID with bounded backoff until ack/expiry.
        const retryMs = Math.min(300_000, 30_000 * 2 ** Math.min(delivery.attempts, 4));
        if (sent && !delivery.sentAt) await prisma.notificationDelivery.updateMany({ where: { id: delivery.id, sentAt: null }, data: { sentAt: new Date() } });
        // A read/claim can invalidate the event while provider HTTP is in
        // flight. Never replace its immediate removal wake with retry backoff.
        await prisma.notificationDelivery.updateMany({ where: { id: delivery.id, invalidatedAt: null }, data: { notBefore: new Date(Date.now() + retryMs) } });
        await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { claimedUntil: null } });
      } catch (error) {
        if (error instanceof fcm.FcmFailure && error.invalidToken) {
          await prisma.notificationInstallation.updateMany({ where: { id: row.id, token: row.token }, data: { token: null, coordinatorEnabled: false } });
          await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { cancelledAt: new Date(), claimedUntil: null } });
        } else {
          await prisma.notificationDelivery.updateMany({ where: { id: delivery.id, invalidatedAt: null }, data: { notBefore: new Date(Date.now() + (delivery.sentAt ? Math.min(300_000, 30_000 * 2 ** Math.min(delivery.attempts, 4)) : Math.min(60_000, 1000 * 2 ** Math.min(delivery.attempts, 6)))) } });
          await prisma.notificationDelivery.update({ where: { id: delivery.id }, data: { claimedUntil: null } });
        }
      }
    }
  } finally { processing = false; }
}
