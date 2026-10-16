import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PrismaClient } from '@prisma/client';
import { io as connect, Socket } from 'socket.io-client';
import bcrypt from 'bcryptjs';
import app from '../dist/app';
import initSockets from '../dist/sockets';

if (process.env.DISPOSABLE_DB_TEST !== 'true' || new URL(process.env.DATABASE_URL!).pathname !== '/tayyn_test') {
  throw new Error('Run through npm run test:integration with its disposable database');
}
const prisma = new PrismaClient();
const server = createServer(app);
const sockets = initSockets(server);
const clients: Socket[] = [];
let base = '';
let adminToken = '';
let driverToken = '';
let otherToken = '';
let regionId = '';
let otherRegionId = '';
const password = 'SyntheticTest123!';

async function request(path: string, token = '', body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data };
}
async function login(phone: string) {
  const result = await request('/auth/login', '', { phone, password });
  assert.equal(result.status, 200);
  return result.data.accessToken as string;
}
async function socket(token: string) {
  const client = connect(base, { auth: { token }, transports: ['websocket'], forceNew: true });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 5000);
    client.once('connect', () => { clearTimeout(timer); resolve(); });
    client.once('connect_error', error => { clearTimeout(timer); reject(error); });
  });
  return client;
}
async function order(priceEstimated: number | null = 10) {
  const response = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: priceEstimated ?? 10, pickupAddress: 'Synthetic pickup', clientPhone: '+10000000999' });
  assert.equal(response.status, 201);
  if (priceEstimated === null) {
    await prisma.order.update({ where: { id: response.data.id }, data: { priceEstimated: null } });
  }
  return response.data;
}

before(async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  await prisma.user.create({ data: { phone: '+10000000000', fullName: 'Test dispatcher', role: 'ADMIN', passwordHash, admin: { create: { permissionLevel: 'SUPER' } } } });
  const region = await prisma.district.create({ data: { name: 'Synthetic west', centerLat: 37.96, centerLng: 58.32 } });
  const otherRegion = await prisma.district.create({ data: { name: 'Synthetic east', centerLat: 37.96, centerLng: 58.42 } });
  regionId = region.id;
  otherRegionId = otherRegion.id;
  for (const [phone, districtId] of [['+10000000101', regionId], ['+10000000102', otherRegionId]]) {
    await prisma.user.create({ data: { phone, fullName: 'Synthetic driver', role: 'DRIVER', passwordHash, driver: { create: { status: 'APPROVED', districtId } }, balance: { create: { amount: 500, currency: 'TMT' } } } });
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  adminToken = await login('+10000000000');
  driverToken = await login('+10000000101');
  otherToken = await login('+10000000102');
});
beforeEach(async () => {
  await prisma.transaction.deleteMany();
  await prisma.order.deleteMany();
  await prisma.balance.updateMany({ data: { amount: 500 } });
  await prisma.driver.updateMany({ data: { isAvailable: true, isOnline: false } });
  await prisma.driver.updateMany({ where: { user: { phone: '+10000000102' } }, data: { districtId: otherRegionId } });
  for (const [token, lng] of [[driverToken, 58.32], [otherToken, 58.42]] as const) {
    assert.equal((await request('/driver/location', token, { lat: 37.96, lng })).status, 200);
    assert.equal((await request('/driver/status', token, { isOnline: true })).status, 200);
  }
});
after(async () => {
  clients.forEach(client => client.disconnect());
  await new Promise<void>(resolve => sockets.close(() => resolve()));
  await prisma.$disconnect();
  // Application and fixture clients have separate connection pools.
  await require('../dist/lib/prisma').$disconnect();
});

test('private driver data requires authentication and dispatcher data requires an admin role', async () => {
  assert.equal((await request('/driver/profile')).status, 401);
  assert.equal((await request('/admin/drivers', driverToken)).status, 403);
});

test('missing or stale GPS blocks online status, order browsing and claims without charging', async () => {
  const created = await order();
  for (const lastLocationAt of [null, new Date(Date.now() - 61000)]) {
    await prisma.driver.updateMany({ where: { user: { phone: '+10000000101' } }, data: { lastLocationAt, isOnline: true } });
    assert.equal((await request('/driver/status', driverToken, { isOnline: true })).status, 403);
    assert.equal((await request('/orders/available', driverToken)).status, 403);
    assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 403);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
    const regions = await request('/districts', driverToken);
    assert.ok(regions.data.every((region: { activeOrders: number }) => region.activeOrders === 0));
  }
});

test('fresh GPS still requires an explicit online choice before browsing or claiming', async () => {
  assert.equal((await request('/driver/status', driverToken, { isOnline: false })).status, 200);
  assert.equal((await request('/driver/location', driverToken, { lat: 37.96, lng: 58.32 })).status, 200);
  const created = await order();
  assert.equal((await request('/orders/available', driverToken)).status, 403);
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 403);
  assert.equal((await request('/driver/status', driverToken, { isOnline: true })).status, 200);
  assert.equal((await request('/orders/available', driverToken)).data[0].id, created.id);
});

test('GPS expiry forces offline without interrupting a claimed trip and fresh GPS does not auto-online', async () => {
  const created = await order();
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 200);
  const client = await socket(driverToken);
  try {
    await prisma.driver.updateMany({ where: { user: { phone: '+10000000101' } }, data: { lastLocationAt: new Date(Date.now() - 59500) } });
    const expired = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('GPS expiry did not emit offline')), 2500);
      client.on('driver:status', event => { if (event.reason === 'GPS_REQUIRED') { clearTimeout(timeout); resolve(event); } });
    });
    assert.equal((await request('/driver/status', driverToken, { isOnline: true })).status, 200);
    const event = await expired;
    assert.equal(event.isOnline, false);
    assert.equal(event.isAvailable, false);
    assert.equal((await request('/driver/profile', driverToken)).data.isOnline, false);
    assert.equal((await request('/orders/current', driverToken)).data.id, created.id);
    for (const action of ['waiting', 'start', 'complete']) {
      assert.equal((await request(`/orders/${action}`, driverToken, { orderId: created.id })).status, 200);
    }
    assert.equal((await request('/driver/location', driverToken, { lat: 37.96, lng: 58.32 })).status, 200);
    assert.equal((await request('/driver/profile', driverToken)).data.isOnline, false);
  } finally { client.disconnect(); }
});

test('stale sockets receive no offers or live queues after balance, region changes or reconnect', async () => {
  let client = await socket(driverToken);
  assert.equal((await request('/driver/status', driverToken, { isOnline: true })).status, 200);
  const received: unknown[] = [];
  const watch = () => {
    client.on('order:new', event => received.push(event));
    client.on('districts:stats', event => received.push(event));
  };
  watch();
  try {
    // Seed a stale timestamp while a previously eligible socket is still joined.
    await prisma.driver.updateMany({ where: { user: { phone: '+10000000101' } }, data: { lastLocationAt: new Date(Date.now() - 61000) } });
    await order();
    const profile = await request('/driver/profile', driverToken);
    assert.equal(profile.data.isOnline, false);
    assert.equal((await request(`/admin/drivers/${profile.data.id}/balance`, adminToken, { amount: 1, type: 'TOPUP' })).status, 200);
    assert.equal((await request('/driver/district', driverToken, { districtId: regionId })).status, 200);
    await order();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(received, []);
    client.disconnect();
    client = await socket(driverToken);
    watch();
    await order();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(received, []);
  } finally { client.disconnect(); }
});

test('dispatcher cannot create an order without a valid customer phone', async () => {
  for (const clientPhone of [undefined, '', '   ', 'call-me', '+', '12']) {
    const response = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, ...(clientPhone === undefined ? {} : { clientPhone }) });
    assert.equal(response.status, 400, `invalid phone ${String(clientPhone)} must be rejected`);
  }
});

test('dispatcher must select a region even when map coordinates are supplied', async () => {
  for (const coordinates of [{}, { pickupLat: 37.96, pickupLng: 58.32 }]) {
    const response = await request('/admin/orders', adminToken, { clientPhone: '+99361234567', priceEstimated: 10, ...coordinates });
    assert.equal(response.status, 400);
  }
});

test('dispatcher must enter a positive order price manually', async () => {
  for (const priceEstimated of [undefined, 0, -5]) {
    const result = await request('/admin/orders', adminToken, { districtId: regionId, clientPhone: '+99361234567', priceEstimated });
    assert.equal(result.status, 400);
  }
});

test('an inherited unpriced order can be completed without a balance charge', async () => {
  const created = { data: await order(null) };
  assert.equal(created.data.districtId, regionId);
  const available = await request('/orders/available', driverToken);
  const offered = available.data.find((item: { id: string }) => item.id === created.data.id);
  assert.ok(offered);
  assert.equal(offered.priceEstimated, null);
  assert.equal('clientPhone' in offered, false);
  const claimed = await request('/orders/accept', driverToken, { orderId: created.data.id });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.clientPhone, '+10000000999');
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  for (const action of ['waiting', 'start', 'complete']) assert.equal((await request(`/orders/${action}`, driverToken, { orderId: created.data.id })).status, 200);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 0);
});

test('a claimed order progresses to completion and charges the quoted TMT price once', async () => {
  const created = await order();
  const body = { orderId: created.id, etaMinutes: 5 };
  assert.equal((await request('/orders/start', driverToken, body)).status, 403);
  const claimed = await request('/orders/accept', driverToken, body);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.status, 'ACCEPTED');
  assert.equal(claimed.data.clientPhone, '+10000000999');
  assert.equal((await request('/orders/complete', driverToken, body)).status, 409);
  for (const [action, status] of [['waiting', 'WAITING'], ['start', 'STARTED'], ['complete', 'COMPLETED']]) {
    const response = await request(`/orders/${action}`, driverToken, body);
    assert.equal(response.status, 200);
    assert.equal(response.data.status, status);
  }
  assert.equal((await request('/orders/complete', driverToken, body)).status, 409);
  const balance = await request('/driver/balance', driverToken);
  assert.equal(balance.data.amount, '490');
  assert.equal(balance.data.currency, 'TMT');
});

test('regional operating car count includes an online driver during a trip', async () => {
  await request('/driver/status', driverToken, { isOnline: true, isAvailable: true });
  const created = await order();
  assert.equal((await request('/orders/accept', driverToken, {orderId: created.id})).status, 200);
  const regions = await request('/districts', driverToken);
  const region = regions.data.find((row: {id: string}) => row.id === regionId);
  assert.equal(region.onlineDrivers, 1);
  assert.equal(region.freeDrivers, 0);
  assert.equal(region.activeOrders, 1);
});

test('only online drivers in the selected region receive an order offer without the customer phone', async () => {
  const own = await socket(driverToken);
  const other = await socket(otherToken);
  try {
    assert.equal((await request('/driver/status', driverToken, { isOnline: true })).status, 200);
    assert.equal((await request('/driver/status', otherToken, { isOnline: true })).status, 200);
    const wrongRegion: unknown[] = [];
    other.on('order:new', event => wrongRegion.push(event));
    const offer = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Region offer was not received')), 3000);
      own.once('order:new', event => { clearTimeout(timer); resolve(event); });
    });
    const created = await order();
    const received = await offer;
    assert.equal(received.id, created.id);
    assert.equal(received.districtId, regionId);
    assert.equal('clientPhone' in received, false);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(wrongRegion, []);
    const offlineOffers: unknown[] = [];
    own.on('order:new', event => offlineOffers.push(event));
    assert.equal((await request('/driver/status', driverToken, { isOnline: false })).status, 200);
    await order();
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.deepEqual(offlineOffers, []);
  } finally {
    own.disconnect();
    other.disconnect();
  }
});

test('competing drivers cannot both claim the same order', async () => {
  await request('/driver/district', otherToken, { districtId: regionId });
  const created = await order();
  const responses = await Promise.all([driverToken, otherToken].map(token => request('/orders/accept', token, { orderId: created.id })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const currentOrders = await Promise.all([driverToken, otherToken].map(token => request('/orders/current', token)));
  assert.equal(currentOrders.filter(response => response.data?.id === created.id).length, 1);
});

test('cancelling a claimed order refunds the synthetic charge and rejects a second cancellation', async () => {
  const created = await order();
  const body = { orderId: created.id };
  assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
  assert.equal((await request('/orders/cancel', driverToken, body)).data.status, 'CANCELLED');
  assert.equal((await request('/orders/cancel', driverToken, body)).status, 409);
  const balance = await request('/driver/balance', driverToken);
  assert.equal(balance.data.amount, '500');
});

test('dispatcher cancellation refunds the quoted charge with matching ledger entries only once', async () => {
  const created = await order();
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 200);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '490');
  const cancelled = await request(`/admin/orders/${created.id}/cancel`, adminToken, { reason: 'Synthetic cancellation' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'CANCELLED');
  assert.equal((await request(`/admin/orders/${created.id}/cancel`, adminToken, {})).status, 409);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  const history = await request('/driver/history', driverToken);
  assert.equal(history.status, 200);
  assert.equal(history.data.transactions.total, 2);
  const entries = history.data.transactions.items.map((entry: {
    orderId: string; type: string; amount: string; balanceAfter: string; note: string;
  }) => ({ orderId: entry.orderId, type: entry.type, amount: entry.amount, balanceAfter: entry.balanceAfter, note: entry.note }));
  assert.deepEqual(entries.find((entry: { type: string }) => entry.type === 'PAYMENT'), {
    orderId: created.id, type: 'PAYMENT', amount: '-10', balanceAfter: '490',
    note: `Заказ #${created.id}: цена поездки списана при принятии`
  });
  assert.deepEqual(entries.find((entry: { type: string }) => entry.type === 'REFUND'), {
    orderId: created.id, type: 'REFUND', amount: '10', balanceAfter: '500',
    note: `Заказ #${created.id}: возврат за отменённую поездку`
  });
});

for (const price of [null, 0, -10]) {
  test(`accepting and cancelling an order priced ${price} leaves the balance and ledger unchanged`, async () => {
    const created = await order(null);
    // Zero/negative prices cannot be created through HTTP; characterize inherited data only.
    if (price !== null) await prisma.order.update({ where: { id: created.id }, data: { priceEstimated: price } });
    const body = { orderId: created.id };
    assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
    assert.equal((await request('/orders/cancel', driverToken, body)).status, 200);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
    assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 0);
  });
}

test('dispatcher creates an approved driver with a zero TMT balance and no leaked password', async () => {
  const body = { phone: '+99361123456', fullName: 'Added synthetic driver', password, districtId: regionId };
  assert.equal((await request('/admin/drivers', driverToken, body)).status, 403);
  assert.equal((await request('/admin/drivers', '', body)).status, 401);
  assert.equal((await request('/admin/drivers', adminToken, { ...body, districtId: '00000000-0000-4000-8000-000000000000' })).status, 404);
  const created = await request('/admin/drivers', adminToken, body);
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'APPROVED');
  assert.equal(created.data.districtId, regionId);
  assert.equal(created.data.user.phone, body.phone);
  assert.equal(created.data.user.balance.amount, '0');
  assert.equal(created.data.user.balance.currency, 'TMT');
  assert.equal('passwordHash' in created.data.user, false);
  assert.equal('password' in created.data.user, false);
  assert.equal((await request('/admin/drivers', adminToken, body)).status, 409);
  const loggedIn = await request('/auth/login', '', { phone: body.phone, password });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.data.user.role, 'DRIVER');
});

test('a newly registered driver can log in only after dispatcher approval', async () => {
  const phone = '+10000000103';
  const registered = await request('/auth/register', '', { phone, password, fullName: 'Pending synthetic driver' });
  assert.equal(registered.status, 201);
  assert.equal((await request('/auth/login', '', { phone, password })).status, 403);
  const approved = await request(`/admin/drivers/${registered.data.user.driver.id}/approve`, adminToken, {});
  assert.equal(approved.status, 200);
  const token = await login(phone);
  assert.equal((await request('/driver/profile', token)).data.status, 'APPROVED');
});

test('canonical region bootstrap persists all finalized polygons and preserves later edits', async () => {
  const { seedDefaultRegions } = require('../prisma/default-regions.cjs');
  const first = await prisma.$transaction(async tx => seedDefaultRegions(tx));
  assert.equal(first.created, 9);
  const response = await request('/admin/districts', adminToken);
  const gurtly = response.data.find((region: { name: string }) => region.name === '30мкр, Гуртлы');
  assert.ok(gurtly);
  assert.equal(gurtly.boundary[0].length, 26);
  const dataset = require('../prisma/data/default-regions.json');
  for (const expected of dataset.regions) {
    const persisted = response.data.find((region: { id: string }) => region.id === expected.id);
    assert.deepEqual(persisted.boundary, expected.boundary);
  }
  const edited = [[[37.94, 58.30], [37.98, 58.30], [37.98, 58.36], [37.94, 58.30]]];
  const saved = await fetch(`${base}/admin/districts/${gurtly.id}/boundary`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ boundary: edited }), signal: AbortSignal.timeout(5000)
  });
  assert.equal(saved.status, 200);
  const repeated = await prisma.$transaction(async tx => seedDefaultRegions(tx));
  assert.deepEqual(repeated, { created: 0, filled: 0, preserved: 9 });
  const reread = await request('/admin/districts', adminToken);
  assert.deepEqual(reread.data.find((region: { id: string }) => region.id === gurtly.id).boundary, edited);
});

test('canonical bootstrap fills a missing boundary without changing an existing region identity', async () => {
  const { seedDefaultRegions } = require('../prisma/default-regions.cjs');
  const { Prisma } = require('@prisma/client');
  await prisma.$transaction(async tx => seedDefaultRegions(tx));
  // Set up an older environment whose named region predates the saved geometry.
  const oldId = '1c1154fc-38c3-40d2-9d08-56a6cabce276';
  const canonicalId = '80c54215-b1a7-4be8-a9c5-2df3053822b6';
  await prisma.district.update({ where: { id: canonicalId }, data: { id: oldId, boundary: Prisma.DbNull } });
  const result = await prisma.$transaction(async tx => seedDefaultRegions(tx));
  assert.equal(result.filled, 1);
  const response = await request('/admin/districts', adminToken);
  const restored = response.data.filter((region: { name: string }) => region.name === '30мкр, Гуртлы');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].id, oldId);
  assert.equal(restored[0].boundary[0].length, 26);
});

test('native shift renews with fresh GPS and returns stable safe order and chat notifications until explicitly stopped', async () => {
  const island = await prisma.district.create({ data: { name: 'Native synthetic island', centerLat: 0, centerLng: 0 } });
  const auth = await request('/auth/login', '', { phone: '+10000000101', password, deviceId: 'native-test-device' });
  await request('/driver/location', auth.data.accessToken, { lat: 0, lng: 0 });
  await request('/driver/status', auth.data.accessToken, { isOnline: true });
  assert.equal(auth.status, 200);
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'native-test-device', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  assert.equal(started.data.pollIntervalMs, 10000);
  const createdResponse = await request('/admin/orders', adminToken, { districtId: island.id, priceEstimated: 10, clientPhone: '+10000000999' });
  assert.equal(createdResponse.status, 201);
  const created = createdResponse.data;
  assert.equal((await request('/admin/messages', adminToken, { driverId: auth.data.user.driver.id, body: 'Private test message' })).status, 200);
  const fix = { lat: 0, lng: 0, recordedAt: new Date().toISOString() };
  const first = await request('/native-shift/tick', started.data.shiftToken, fix);
  assert.equal(first.status, 200);
  assert.ok(first.data.events.some((event: { orderId?: string }) => event.orderId === created.id));
  assert.ok(first.data.events.some((event: { channel: string }) => event.channel === 'chat'));
  assert.ok(!JSON.stringify(first.data.events).includes('+10000000999'));
  assert.ok(!JSON.stringify(first.data.events).includes('Private test message'));
  const second = await request('/native-shift/tick', started.data.shiftToken, fix);
  assert.deepEqual(second.data.events.map((event: { id: string }) => event.id), first.data.events.map((event: { id: string }) => event.id));
  assert.equal((await request('/driver/messages/read', auth.data.accessToken, {})).status, 204);
  assert.equal((await request('/orders/accept', auth.data.accessToken, { orderId: created.id })).status, 200);
  const consumed = await request('/native-shift/tick', started.data.shiftToken, fix);
  assert.deepEqual(consumed.data.events, []);
  const sender = await prisma.user.findUniqueOrThrow({ where: { phone: '+10000000000' } });
  const sentAt = new Date(Date.now() + 1);
  await prisma.message.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ id: `native-chat-overflow-${i}`, senderId: sender.id, receiverId: auth.data.user.id, body: 'Synthetic older unread', sentAt })) });
  await prisma.message.create({ data: { id: 'native-chat-newest', senderId: sender.id, receiverId: auth.data.user.id, body: 'Synthetic newest unread', sentAt: new Date(sentAt.getTime() + 1) } });
  const overflow = await request('/native-shift/tick', started.data.shiftToken, fix);
  assert.ok(overflow.data.events.some((event: { messageId?: string }) => event.messageId === 'native-chat-newest'));
  assert.equal((await request('/driver/shift/stop', auth.data.accessToken, {})).status, 204);
  assert.equal((await request('/native-shift/tick', started.data.shiftToken, fix)).status, 401);
  assert.equal((await request('/driver/profile', auth.data.accessToken)).data.isOnline, false);
  await request('/driver/status', auth.data.accessToken, { isOnline: true });
  await request('/native-shift/stop', started.data.shiftToken, {});
  assert.equal((await request('/driver/profile', auth.data.accessToken)).data.isOnline, true);
});


test('native shift cannot start without matching device and GPS or renew with a stale fix, expired lease or logout', async () => {
  const auth = await request('/auth/login', '', { phone: '+10000000101', password, deviceId: 'native-test-device' });
  const body = { deviceId: 'native-test-device', refreshToken: auth.data.refreshToken };
  assert.equal((await request('/driver/shift', auth.data.accessToken, { ...body, deviceId: 'wrong-device' })).status, 403);
  await request('/driver/status', auth.data.accessToken, { isOnline: false });
  assert.equal((await request('/driver/shift', auth.data.accessToken, body)).status, 403);
  await request('/driver/status', auth.data.accessToken, { isOnline: true });
  const first = await request('/driver/shift', auth.data.accessToken, body);
  assert.equal(first.status, 201);
  const fix = { lat: 0, lng: 0, recordedAt: new Date().toISOString() };
  assert.equal((await request('/native-shift/tick', first.data.shiftToken, { ...fix, recordedAt: new Date(Date.now() - 31000).toISOString() })).status, 400);
  assert.equal((await request('/native-shift/tick', 'invalid-token', fix)).status, 401);
  await prisma.$executeRaw`UPDATE native_shift_leases SET expires_at = NOW() - INTERVAL '1 second'`;
  assert.equal((await request('/native-shift/tick', first.data.shiftToken, fix)).status, 401);
  const second = await request('/driver/shift', auth.data.accessToken, body);
  assert.equal(second.status, 201);
  await request('/native-shift/stop', first.data.shiftToken, {});
  assert.equal((await request('/native-shift/tick', second.data.shiftToken, fix)).status, 200);
  await request('/auth/logout', '', { refreshToken: auth.data.refreshToken });
  assert.equal((await request('/native-shift/tick', second.data.shiftToken, fix)).status, 401);
  assert.equal((await request('/driver/profile', auth.data.accessToken)).data.isOnline, false);
});
