import { createHash, randomBytes } from 'node:crypto';
import type { Driver } from '@prisma/client';
import prisma from '../../lib/prisma';
import ApiError from '../../utils/ApiError';
import { assertOrderEligibility, GPS_FRESHNESS_MS } from '../driver/gps-eligibility';
import { hashRefreshToken } from '../../utils/jwt';
import { syncDriverDistrictRoom } from '../../sockets/roomSync';
import districts from '../districts/districts.service';
import { getIO } from '../../lib/socket';
import rooms from '../../sockets/rooms';
import logger from '../../config/logger';

type Lease = { driver_id: string; device_id: string; started_at: Date; expires_at: Date; revoked_at: Date | null };
type Fix = { lat: number; lng: number; recordedAt: string; accuracy?: number };
type Event = { id: string; channel: 'orders' | 'chat'; title: string; body: string; expiresAt: string; orderId?: string; messageId?: string };
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

async function broadcastStopped(driverId: string): Promise<void> {
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver || driver.isOnline) return;
  try {
    getIO().to(rooms.driver(driverId)).to(rooms.admins()).emit('driver:status', {
      driverId, isOnline: false, isAvailable: driver.isAvailable,
      updatedAt: driver.updatedAt.toISOString(), reason: 'SHIFT_ENDED'
    });
  } catch (err) { logger.warn({ err }, 'Failed to broadcast native shift stop'); }
}
export async function revokeDriverShift(driverId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE driver_id = ${driverId} AND revoked_at IS NULL`;
}
export async function revokeUserShift(userId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE driver_id IN (SELECT id FROM drivers WHERE user_id = ${userId}) AND revoked_at IS NULL`;
  await prisma.driver.updateMany({ where: { userId }, data: { isOnline: false } });
  const driver = await prisma.driver.findUnique({ where: { userId } });
  if (driver) { await broadcastStopped(driver.id); await syncDriverDistrictRoom(driver.id); await districts.broadcastDistrictStats(); }
}
export async function start(driver: Driver, deviceId: string, refreshToken: string) {
  assertOrderEligibility(driver);
  if (!driver.currentDeviceId || driver.currentDeviceId !== deviceId) throw ApiError.forbidden('Устройство не подтверждено');
  const session = await prisma.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(refreshToken) } });
  if (!session || session.userId !== driver.userId || session.revokedAt || session.expiresAt.getTime() <= Date.now()) throw ApiError.unauthorized();
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + GPS_FRESHNESS_MS);
  const hash = digest(token);
  await prisma.$executeRaw`INSERT INTO native_shift_leases (driver_id, token_hash, device_id, started_at, expires_at) VALUES (${driver.id}, ${hash}, ${deviceId}, ${now}, ${expires}) ON CONFLICT (driver_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, device_id = EXCLUDED.device_id, started_at = EXCLUDED.started_at, expires_at = EXCLUDED.expires_at, revoked_at = NULL`;
  return { shiftToken: token, leaseExpiresAt: expires.toISOString(), pollIntervalMs: 10000 };
}
export async function stop(driver: Driver): Promise<void> {
  await revokeDriverShift(driver.id);
  await prisma.driver.updateMany({ where: { id: driver.id }, data: { isOnline: false } });
  await broadcastStopped(driver.id);
  await syncDriverDistrictRoom(driver.id);
  await districts.broadcastDistrictStats();
}
export async function stopToken(token: string): Promise<void> {
  const stopped = await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Lease[]>`SELECT * FROM native_shift_leases WHERE token_hash = ${digest(token)} AND revoked_at IS NULL AND expires_at > NOW() FOR UPDATE`;
    const lease = rows[0];
    if (!lease) return null;
    await tx.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW() WHERE token_hash = ${digest(token)}`;
    await tx.driver.updateMany({ where: { id: lease.driver_id }, data: { isOnline: false } });
    return lease.driver_id;
  });
  if (stopped) { await broadcastStopped(stopped); await syncDriverDistrictRoom(stopped); await districts.broadcastDistrictStats(); }
}
export async function tick(token: string, fix: Fix) {
  const now = new Date();
  const recordedAt = new Date(fix.recordedAt);
  const age = now.getTime() - recordedAt.getTime();
  if (!Number.isFinite(age) || age < -5000 || age > 30000) throw ApiError.badRequest('Требуется свежее местоположение');
  const nearest = await districts.findNearestDistrictForPoint(fix.lat, fix.lng);
  const renewed = await prisma.$transaction(async tx => {
    const rows = await tx.$queryRaw<Lease[]>`SELECT * FROM native_shift_leases WHERE token_hash = ${digest(token)} FOR UPDATE`;
    const lease = rows[0];
    if (!lease || lease.revoked_at || lease.expires_at.getTime() <= now.getTime()) throw ApiError.unauthorized('Смена завершена');
    // Lock driver status against explicit offline/admin/device changes during renewal.
    await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${lease.driver_id} FOR UPDATE`;
    const driver = await tx.driver.findUnique({ where: { id: lease.driver_id }, include: { user: { include: { balance: true } } } });
    if (!driver || !driver.isOnline || driver.status !== 'APPROVED' || driver.user.status === 'BLOCKED' || driver.currentDeviceId !== lease.device_id) throw ApiError.unauthorized('Смена завершена');
    const expires = new Date(now.getTime() + GPS_FRESHNESS_MS);
    await tx.$executeRaw`UPDATE native_shift_leases SET expires_at = ${expires} WHERE driver_id = ${driver.id}`;
    const updated = await tx.driver.update({ where: { id: driver.id }, data: { lastLat: fix.lat, lastLng: fix.lng, lastLocationAt: now, ...(nearest ? { districtId: nearest.id } : {}) } });
    await tx.driverLocation.create({ data: { driverId: driver.id, lat: fix.lat, lng: fix.lng, accuracy: fix.accuracy, recordedAt } });
    return { driver: updated, lease, expires, balance: Number(driver.user.balance?.amount ?? 0) };
  });
  try {
    getIO().to(rooms.admins()).to(rooms.driver(renewed.driver.id)).emit('driver:location', { driverId: renewed.driver.id, lat: fix.lat, lng: fix.lng, recordedAt: now.toISOString() });
  } catch (err) { logger.warn({ err }, 'Failed to broadcast native driver location'); }
  await syncDriverDistrictRoom(renewed.driver.id);
  await districts.broadcastDistrictStats();
  const events: Event[] = [];
  const active = await prisma.order.findFirst({ where: { driverId: renewed.driver.id, status: { in: ['ACCEPTED', 'WAITING', 'STARTED'] } }, select: { id: true } });
  if (!active && renewed.driver.isAvailable && renewed.balance > 0) {
    // to_jsonb tolerates installs before the additive private-offer migration.
    // Never deliver a reserved order to anyone except its intended recipient.
    const orders = await prisma.$queryRaw<Array<{ id: string; private_expiry: string | null }>>`SELECT o.id, to_jsonb(o)->>'private_offer_expires_at' AS private_expiry FROM orders o WHERE o.status = 'NEW' AND o.driver_id IS NULL AND ((to_jsonb(o)->>'private_offer_driver_id' IS NULL AND o.district_id = ${renewed.driver.districtId}) OR (to_jsonb(o)->>'private_offer_driver_id' = ${renewed.driver.id} AND (to_jsonb(o)->>'private_offer_expires_at')::timestamptz > ${now})) ORDER BY o.created_at ASC LIMIT 100`;
    for (const order of orders) events.push({ id: order.private_expiry ? `private:${order.id}:${new Date(order.private_expiry).toISOString()}` : `order:${order.id}`, channel: 'orders', title: 'Новый заказ', body: order.private_expiry ? 'Личное предложение. Откройте приложение.' : 'Заказ в вашем районе. Откройте приложение.', orderId: order.id, expiresAt: order.private_expiry ? new Date(order.private_expiry).toISOString() : renewed.expires.toISOString() });
  }
  const after = new Date(Math.max(renewed.lease.started_at.getTime(), renewed.driver.lastChatReadAt?.getTime() ?? 0));
  const messages = await prisma.message.findMany({ where: { OR: [{ receiverId: renewed.driver.userId }, { isBroadcast: true }], NOT: { senderId: renewed.driver.userId }, sentAt: { gt: after } }, select: { id: true }, orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], take: 100 });
  for (const message of messages) events.push({ id: `chat:${message.id}`, channel: 'chat', title: 'Сообщение диспетчера', body: 'Откройте чат в приложении.', messageId: message.id, expiresAt: renewed.expires.toISOString() });
  return { serverTime: now.toISOString(), leaseExpiresAt: renewed.expires.toISOString(), events };
}
