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

type Lease = { driver_id: string; device_id: string; started_at: Date; expires_at: Date; revoked_at: Date | null; credential_version: number };
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
export async function start(driver: Driver, deviceId: string, refreshToken: string, credentialVersion: number) {
  const token = randomBytes(32).toString('base64url');
  const expires = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${driver.userId} FOR UPDATE`;
    const current = await tx.driver.findUniqueOrThrow({ where: { id: driver.id }, include: { user: true } });
    if (current.user.credentialVersion !== credentialVersion || current.user.status === 'BLOCKED' || current.status !== 'APPROVED') throw ApiError.unauthorized();
    assertOrderEligibility(current);
    if (!current.currentDeviceId || current.currentDeviceId !== deviceId) throw ApiError.forbidden('Устройство не подтверждено');
    const session = await tx.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(refreshToken) } });
    if (!session || session.userId !== current.userId || session.credentialVersion !== credentialVersion || session.revokedAt || session.expiresAt.getTime() <= Date.now()) throw ApiError.unauthorized();
    const now = new Date();
    const expires = new Date(now.getTime() + GPS_FRESHNESS_MS);
    const hash = digest(token);
    await tx.$executeRaw`INSERT INTO native_shift_leases (driver_id, token_hash, device_id, started_at, expires_at, credential_version) VALUES (${current.id}, ${hash}, ${deviceId}, ${now}, ${expires}, ${credentialVersion}) ON CONFLICT (driver_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, device_id = EXCLUDED.device_id, started_at = EXCLUDED.started_at, expires_at = EXCLUDED.expires_at, credential_version = EXCLUDED.credential_version, revoked_at = NULL`;
    return expires;
  });
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
    await tx.$queryRaw`SELECT u.id FROM users u JOIN drivers d ON d.user_id = u.id JOIN native_shift_leases n ON n.driver_id = d.id WHERE n.token_hash = ${digest(token)} FOR UPDATE OF u`;
    const rows = await tx.$queryRaw<Lease[]>`SELECT * FROM native_shift_leases WHERE token_hash = ${digest(token)} AND revoked_at IS NULL AND expires_at > NOW() FOR UPDATE`;
    const lease = rows[0];
    if (!lease) return null;
    const current = await tx.driver.findUnique({ where: { id: lease.driver_id }, include: { user: true } });
    if (!current || current.user.credentialVersion !== lease.credential_version) return null;
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
    // The same user lock guards password/phone changes, availability and native renewal.
    await tx.$queryRaw`SELECT u.id FROM users u JOIN drivers d ON d.user_id = u.id JOIN native_shift_leases n ON n.driver_id = d.id WHERE n.token_hash = ${digest(token)} FOR UPDATE OF u`;
    const rows = await tx.$queryRaw<Lease[]>`SELECT * FROM native_shift_leases WHERE token_hash = ${digest(token)} FOR UPDATE`;
    const lease = rows[0];
    if (!lease || lease.revoked_at || lease.expires_at.getTime() <= now.getTime()) throw ApiError.unauthorized('Смена завершена');
    // Lock driver status against explicit offline/admin/device changes during renewal.
    await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${lease.driver_id} FOR UPDATE`;
    const driver = await tx.driver.findUnique({ where: { id: lease.driver_id }, include: { user: { include: { balance: true } } } });
    if (!driver || !driver.isOnline || driver.status !== 'APPROVED' || driver.user.status === 'BLOCKED' || driver.user.credentialVersion !== lease.credential_version || driver.currentDeviceId !== lease.device_id) throw ApiError.unauthorized('Смена завершена');
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
    const orders = await prisma.order.findMany({
      where: { status: 'NEW', driverId: null, OR: [
        { privateOfferDriverId: null, districtId: renewed.driver.districtId },
        { privateOfferDriverId: renewed.driver.id, privateOfferExpiresAt: { gt: now } }
      ] },
      select: { id: true, privateOfferExpiresAt: true }, orderBy: { createdAt: 'asc' }, take: 100
    });
    for (const order of orders) {
      const expiry = order.privateOfferExpiresAt?.toISOString();
      events.push({ id: expiry ? `private:${order.id}:${expiry}` : `order:${order.id}`, channel: 'orders', title: 'Новый заказ', body: expiry ? 'Личное предложение. Откройте приложение.' : 'Заказ в вашем районе. Откройте приложение.', orderId: order.id, expiresAt: expiry ?? renewed.expires.toISOString() });
    }
  }
  const after = new Date(Math.max(renewed.lease.started_at.getTime(), renewed.driver.lastChatReadAt?.getTime() ?? 0));
  const messages = await prisma.message.findMany({ where: { OR: [{ receiverId: renewed.driver.userId }, { isBroadcast: true }], NOT: { senderId: renewed.driver.userId }, sentAt: { gt: after } }, select: { id: true }, orderBy: [{ sentAt: 'desc' }, { id: 'desc' }], take: 100 });
  for (const message of messages) events.push({ id: `chat:${message.id}`, channel: 'chat', title: 'Сообщение диспетчера', body: 'Откройте чат в приложении.', messageId: message.id, expiresAt: renewed.expires.toISOString() });
  return { serverTime: now.toISOString(), leaseExpiresAt: renewed.expires.toISOString(), events };
}
