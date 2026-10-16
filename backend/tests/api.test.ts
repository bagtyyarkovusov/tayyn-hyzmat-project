import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { PrismaClient, type Prisma } from '@prisma/client';
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
let testClient = 1;
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
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `127.0.1.${testClient}`,  ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
function nextSocketEvent<T>(client: Socket, event: string, timeout = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off(event, receive); reject(new Error(`Missing ${event}`)); }, timeout);
    function receive(payload: T) { clearTimeout(timer); resolve(payload); }
    client.once(event, receive);
  });
}
async function socketEvent(client: Socket, event: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Expected socket ${event}`)), 3000);
    client.once(event, (...args: any[]) => { clearTimeout(timer); resolve(args); });
  });
}
async function order(priceEstimated: number | null = 10) {
  const response = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: priceEstimated ?? 10, pickupAddress: 'Synthetic pickup', clientPhone: '+99360000999' });
  assert.equal(response.status, 201);
  if (priceEstimated === null) {
    await prisma.order.update({ where: { id: response.data.id }, data: { priceEstimated: null } });
  }
  return response.data;
}

before(async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  await prisma.user.create({ data: { phone: '+99360000000', fullName: 'Test dispatcher', role: 'ADMIN', passwordHash, admin: { create: { permissionLevel: 'SUPER' } } } });
  const region = await prisma.district.create({ data: { name: 'Synthetic west', centerLat: 37.96, centerLng: 58.32, boundary: [[[37.94, 58.30], [37.98, 58.30], [37.98, 58.36], [37.94, 58.36]]] } });
  const otherRegion = await prisma.district.create({ data: { name: 'Synthetic east', centerLat: 37.96, centerLng: 58.42, boundary: [[[37.94, 58.38], [37.98, 58.38], [37.98, 58.46], [37.94, 58.46]]] } });
  regionId = region.id;
  otherRegionId = otherRegion.id;
  for (const [phone, districtId] of [['+99360000101', regionId], ['+99360000102', otherRegionId]]) {
    await prisma.user.create({ data: { phone, fullName: 'Synthetic driver', role: 'DRIVER', passwordHash, driver: { create: { status: 'APPROVED', districtId } }, balance: { create: { amount: 500, currency: 'TMT' } } } });
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  adminToken = await login('+99360000000');
  driverToken = await login('+99360000101');
  otherToken = await login('+99360000102');
});
beforeEach(async () => {
  testClient++;
  await prisma.transaction.deleteMany();
  await prisma.order.deleteMany();
  await prisma.balance.updateMany({ data: { amount: 500 } });
  await prisma.driver.updateMany({ data: { isAvailable: true, isOnline: false } });
  await prisma.driver.updateMany({ where: { user: { phone: '+99360000102' } }, data: { districtId: otherRegionId } });
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

test('GPS outside saved regions clears the previous region without hiding the real position or going offline', async () => {
  const within = await request('/driver/location', driverToken, { lat: 37.96, lng: 58.32 });
  assert.equal(within.status, 200);
  assert.equal(within.data.districtId, regionId);
  const outside = await request('/driver/location', driverToken, { lat: 30.2329, lng: 120.0399 });
  assert.equal(outside.status, 200);
  const profile = await request('/driver/profile', driverToken);
  assert.equal(profile.data.districtId, null);
  assert.equal(Number(profile.data.lastLat), 30.2329);
  assert.equal(Number(profile.data.lastLng), 120.0399);
  assert.equal(profile.data.isOnline, true);
  const regions = await request('/districts', driverToken);
  assert.equal(regions.data.find((region: { id: string }) => region.id === regionId).onlineDrivers, 0);
  const publicOrder = await order();
  assert.equal((await request(`/orders/available?districtId=${regionId}`, driverToken)).status, 200);
  assert.equal((await request('/orders/accept', driverToken, { orderId: publicOrder.id, arrivalMinutes: 5 })).status, 200);
  const returned = await request('/driver/location', driverToken, { lat: 37.96, lng: 58.32 });
  assert.equal(returned.data.districtId, regionId);
});

test('private driver data requires authentication and dispatcher data requires an admin role', async () => {
  assert.equal((await request('/driver/profile')).status, 401);
  assert.equal((await request('/admin/drivers', driverToken)).status, 403);
});

test('missing or stale GPS blocks online status, order browsing and claims without charging', async () => {
  const created = await order();
  for (const lastLocationAt of [null, new Date(Date.now() - 61000)]) {
    await prisma.driver.updateMany({ where: { user: { phone: '+99360000101' } }, data: { lastLocationAt, isOnline: true } });
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
    await prisma.driver.updateMany({ where: { user: { phone: '+99360000101' } }, data: { lastLocationAt: new Date(Date.now() - 59500) } });
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
    await prisma.driver.updateMany({ where: { user: { phone: '+99360000101' } }, data: { lastLocationAt: new Date(Date.now() - 61000) } });
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
  assert.equal(claimed.data.clientPhone, '+99360000999');
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
  assert.equal(claimed.data.clientPhone, '+99360000999');
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

test('dispatcher can explicitly resolve a stuck started trip with an audit reason', async () => {
  const created = await order();
  const body = { orderId: created.id };
  assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
  assert.equal((await request('/orders/waiting', driverToken, body)).status, 200);
  assert.equal((await request('/orders/start', driverToken, body)).status, 200);
  await prisma.order.update({
    where: { id: created.id },
    data: { startedAt: new Date(Date.now() - 20 * 60 * 1000) }
  });

  const visible = await request('/admin/orders?status=active', adminToken);
  const row = visible.data.items.find((item: { id: string }) => item.id === created.id);
  assert.equal(row.needsCompletion, true);
  assert.ok(row.startedAgeSeconds >= 20 * 60);
  assert.equal((await request(`/admin/orders/${created.id}/force-resolve`, adminToken, {})).status, 400);

  const resolved = await request(`/admin/orders/${created.id}/force-resolve`, adminToken, { reason: 'Клиент подтвердил завершение по телефону' });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.status, 'COMPLETED');
  assert.equal((await request('/orders/current', driverToken)).data, null);
  const driver = await request('/driver/profile', driverToken);
  assert.equal(driver.data.isAvailable, true);
  const audit = await prisma.orderResolutionAudit.findFirst({ where: { orderId: created.id } });
  assert.equal(audit?.action, 'FORCE_COMPLETED');
  assert.equal(audit?.reason, 'Клиент подтвердил завершение по телефону');
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '490');
  assert.equal((await request(`/admin/orders/${created.id}/force-resolve`, adminToken, { reason: 'Повтор' })).status, 409);
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
  const body = { phone: '+99361123456', fullName: 'Added synthetic driver', password };
  assert.equal((await request('/admin/drivers', driverToken, body)).status, 403);
  assert.equal((await request('/admin/drivers', '', body)).status, 401);
  const created = await request('/admin/drivers', adminToken, body);
  assert.equal(created.status, 201);
  assert.equal(created.data.status, 'APPROVED');
  assert.equal(created.data.districtId, null);
  assert.equal(created.data.isOnline, false);
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
  const phone = '+99360000103';
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

test('native inbox safely replays notifications and removes consumed orders and chats', async () => {
  const island = await prisma.district.create({ data: { name: 'Native synthetic island', centerLat: 0, centerLng: 0, boundary: [[[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01]]] } });
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'native-test-device' });
  await request('/driver/location', auth.data.accessToken, { lat: 0, lng: 0 });
  await request('/driver/status', auth.data.accessToken, { isOnline: true });
  assert.equal(auth.status, 200);
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'native-test-device', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  assert.equal(started.data.pollIntervalMs, 10000);
  const createdResponse = await request('/admin/orders', adminToken, { districtId: island.id, priceEstimated: 10, clientPhone: '+99360000999' });
  assert.equal(createdResponse.status, 201);
  const created = createdResponse.data;
  assert.equal((await request('/admin/messages', adminToken, { driverId: auth.data.user.driver.id, body: 'Private test message' })).status, 200);
  const fix = { lat: 0, lng: 0, recordedAt: new Date().toISOString() };
  const first = await request('/native-shift/tick', started.data.shiftToken, fix);
  assert.equal(first.status, 200);
  assert.ok(first.data.events.some((event: { orderId?: string }) => event.orderId === created.id));
  assert.ok(first.data.events.some((event: { channel: string }) => event.channel === 'chat'));
  assert.ok(!JSON.stringify(first.data.events).includes('+99360000999'));
  assert.ok(!JSON.stringify(first.data.events).includes('Private test message'));
  const second = await request('/native-shift/tick', started.data.shiftToken, fix);
  assert.deepEqual(second.data.events.map((event: { id: string }) => event.id), first.data.events.map((event: { id: string }) => event.id));
  assert.equal((await request('/driver/messages/read', auth.data.accessToken, {})).status, 204);
  assert.equal((await request('/orders/accept', auth.data.accessToken, { orderId: created.id })).status, 200);
  const consumed = await request('/native-shift/tick', started.data.shiftToken, fix);
  assert.deepEqual(consumed.data.events, []);
});

test('native chat inbox includes the newest unread message when more than one hundred are pending', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'native-test-device' });
  await request('/driver/location', auth.data.accessToken, { lat: 37.96, lng: 58.32 });
  await request('/driver/status', auth.data.accessToken, { isOnline: true });
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'native-test-device', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  const fix = { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() };
  const sender = await prisma.user.findUniqueOrThrow({ where: { phone: '+99360000000' } });
  const sentAt = new Date(Date.now() + 1);
  await prisma.message.createMany({ data: Array.from({ length: 100 }, (_, i) => ({ id: `native-chat-overflow-${i}`, senderId: sender.id, receiverId: auth.data.user.id, body: 'Synthetic older unread', sentAt })) });
  await prisma.message.create({ data: { id: 'native-chat-newest', senderId: sender.id, receiverId: auth.data.user.id, body: 'Synthetic newest unread', sentAt: new Date(sentAt.getTime() + 1) } });
  const overflow = await request('/native-shift/tick', started.data.shiftToken, fix);
  assert.ok(overflow.data.events.some((event: { messageId?: string }) => event.messageId === 'native-chat-newest'));

});


test('native shift cannot start without matching device and GPS or renew with a stale fix, expired lease or logout', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'native-test-device' });
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

test('native task stop publishes persisted offline state to the driver and dispatcher', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'native-test-device' });
  await request('/driver/location', auth.data.accessToken, { lat: 37.96, lng: 58.32 });
  await request('/driver/status', auth.data.accessToken, { isOnline: true });
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'native-test-device', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  const driver = await socket(auth.data.accessToken);
  const admin = await socket(adminToken);
  const stopped = (client: Socket) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Offline shift status was not broadcast')), 1500);
    client.on('driver:status', event => {
      if (event.driverId !== auth.data.user.driver.id || event.isOnline !== false) return;
      clearTimeout(timer);
      resolve(event);
    });
  });
  const observed = Promise.all([stopped(driver), stopped(admin)]);
  const result = await request('/native-shift/stop', started.data.shiftToken, {});
  assert.equal(result.status, 204);
  for (const event of await observed) assert.equal(event.reason, 'SHIFT_ENDED');
  assert.equal((await request('/driver/profile', auth.data.accessToken)).data.isOnline, false);
});

test('explicit shift stop revokes its credential and a later replay cannot offline the driver', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'native-test-device' });
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'native-test-device', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  assert.equal((await request('/driver/shift/stop', auth.data.accessToken, {})).status, 204);
  const fix = { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() };
  assert.equal((await request('/native-shift/tick', started.data.shiftToken, fix)).status, 401);
  assert.equal((await request('/driver/profile', auth.data.accessToken)).data.isOnline, false);
  assert.equal((await request('/driver/status', auth.data.accessToken, { isOnline: true })).status, 200);
  assert.equal((await request('/native-shift/stop', started.data.shiftToken, {})).status, 204);
  assert.equal((await request('/driver/profile', auth.data.accessToken)).data.isOnline, true);
});
for (const scenario of ['driver-driver', 'admin-admin', 'driver-admin']) {
  test(`cancellation stress: ${scenario} refunds exactly once across 20 races`, async () => {
    const failures: unknown[] = [];
    for (let round = 0; round < 20; round++) {
      const before = Number((await request('/driver/balance', driverToken)).data.amount);
      const created = await order();
      const body = { orderId: created.id };
      assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
      const driverCancel = () => request('/orders/cancel', driverToken, body);
      const adminCancel = () => request(`/admin/orders/${created.id}/cancel`, adminToken, {});
      const responses = await Promise.all(scenario === 'driver-driver' ? [driverCancel(), driverCancel()] : scenario === 'admin-admin' ? [adminCancel(), adminCancel()] : [driverCancel(), adminCancel()]);
      const after = Number((await request('/driver/balance', driverToken)).data.amount);
      const history = (await request('/driver/history', driverToken)).data;
      const refunds = history.transactions.items.filter((entry: {orderId: string; type: string}) => entry.orderId === created.id && entry.type === 'REFUND').length;
      if (after !== before || refunds !== 1 || responses.filter(r => r.status === 200).length !== 1) failures.push({round, statuses: responses.map(r => r.status), before, after, refunds});
    }
    assert.equal(failures.length, 0, 'concurrent cancellation must refund once and have one winner');
  });
}

test('cancellation flow: closes without requeue, frees driver, and forbids driver cancellation after start', async () => {
  const created = await order();
  const body = { orderId: created.id };
  assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
  assert.equal((await request('/orders/cancel', driverToken, body)).status, 200);
  assert.equal((await request('/orders/current', driverToken)).data, null);
  assert.equal((await request('/driver/profile', driverToken)).data.isAvailable, true);
  assert.equal((await request('/orders/available', driverToken)).data.some((o: {id: string}) => o.id === created.id), false);
  const next = await order();
  const nextBody = {orderId: next.id};
  assert.equal((await request('/orders/accept', driverToken, nextBody)).status, 200);
  assert.equal((await request('/orders/waiting', driverToken, nextBody)).status, 200);
  assert.equal((await request('/orders/start', driverToken, nextBody)).status, 200);
  assert.equal((await request('/orders/cancel', driverToken, nextBody)).status, 409);
  assert.equal((await request('/orders/current', driverToken)).data.status, 'STARTED');
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '490');
});

test('cancellation stress: competing start and cancel cannot resurrect a cancelled trip', async () => {
  const failures: unknown[] = [];
  for (let round = 0; round < 20; round++) {
    await prisma.order.deleteMany();
    await prisma.driver.updateMany({data:{isAvailable:true}});
    await prisma.balance.updateMany({data:{amount:500}});
    const created = await order();
    const body = {orderId:created.id};
    assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
    assert.equal((await request('/orders/waiting', driverToken, body)).status, 200);
    const responses = await Promise.all([request('/orders/start', driverToken, body), request('/orders/cancel', driverToken, body)]);
    const current = (await request('/orders/current', driverToken)).data;
    const balance = Number((await request('/driver/balance', driverToken)).data.amount);
    if (responses.filter(r=>r.status===200).length !== 1 || (current?.status === 'STARTED' && balance !== 490) || (!current && balance !== 500)) failures.push({round,statuses:responses.map(r=>r.status),current:current?.status ?? null,balance});
  }
  assert.equal(failures.length,0,'only one allowed state transition may win');
});


test('concurrent claims of different orders keep one active trip and one debit', async () => {
  for (let round = 0; round < 20; round++) {
    const first = await order();
    const second = await order();
    const responses = await Promise.all([first, second].map(created => request('/orders/accept', driverToken, { orderId: created.id })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const current = (await request('/orders/current', driverToken)).data;
    assert.ok([first.id, second.id].includes(current.id));
    assert.equal((await request('/driver/profile', driverToken)).data.isAvailable, false);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '490');
    assert.equal((await request('/orders/cancel', driverToken, { orderId: current.id })).status, 200);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  }
});

test('cancellation wins once over repeated arrival and emits one committed refund', async () => {
  const client = await socket(adminToken);
  const created = await order();
  const body = { orderId: created.id };
  assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
  const cancelled: string[] = [];
  const refunds: string[] = [];
  client.on('order:cancelled', event => { if (event.id === created.id) cancelled.push(event.id); });
  client.on('balance:updated', event => { if (event.orderId === created.id && event.reason === 'REFUND') refunds.push(event.orderId); });
  const responses = await Promise.all([
    request('/orders/waiting', driverToken, body),
    request('/orders/cancel', driverToken, body),
    request('/orders/cancel', driverToken, body)
  ]);
  assert.equal(responses.filter(response => response.status === 200 && response.data.status === 'CANCELLED').length, 1);
  assert.equal((await request('/orders/current', driverToken)).data, null);
  assert.equal((await request('/orders/waiting', driverToken, body)).status, 409);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(cancelled.length, 1);
  assert.equal(refunds.length, 1);
  client.disconnect();
});

test('dispatcher cancellation and trip completion have one terminal winner', async () => {
  for (let round = 0; round < 20; round++) {
    await prisma.order.deleteMany();
    await prisma.driver.updateMany({ data: { isAvailable: true } });
    await prisma.balance.updateMany({ data: { amount: 500 } });
    const created = await order();
    const body = { orderId: created.id };
    assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
    assert.equal((await request('/orders/waiting', driverToken, body)).status, 200);
    assert.equal((await request('/orders/start', driverToken, body)).status, 200);
    const responses = await Promise.all([
      request('/orders/complete', driverToken, body),
      request(`/admin/orders/${created.id}/cancel`, adminToken, {})
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const winner = responses.find(response => response.status === 200)!;
    assert.equal((await request('/driver/balance', driverToken)).data.amount, winner.data.status === 'COMPLETED' ? '490' : '500');
    assert.equal((await request('/orders/current', driverToken)).data, null);
    assert.equal((await request('/driver/profile', driverToken)).data.isAvailable, true);
  }
});

test('a claim racing dispatcher cancellation never leaves an unpaid active trip', async () => {
  for (let round = 0; round < 20; round++) {
    const created = await order();
    const responses = await Promise.all([
      request('/orders/accept', driverToken, { orderId: created.id }),
      request(`/admin/orders/${created.id}/cancel`, adminToken, {})
    ]);
    assert.ok(responses.every(response => [200, 409].includes(response.status)));
    const current = (await request('/orders/current', driverToken)).data;
    const balance = (await request('/driver/balance', driverToken)).data.amount;
    if (current) {
      assert.equal(current.id, created.id);
      assert.equal(current.status, 'ACCEPTED');
      assert.equal(balance, '490');
      assert.equal((await request('/orders/cancel', driverToken, { orderId: created.id })).status, 200);
    } else {
      assert.equal(balance, '500');
      assert.equal(responses[1].status, 200);
    }
    assert.equal((await request('/driver/profile', driverToken)).data.isAvailable, true);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  }
});

test('concurrent topups preserve every credit and its ledger balance', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  for (let batch = 0; batch < 10; batch++) {
    const responses = await Promise.all(Array.from({ length: 8 }, () =>
      request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 1, type: 'TOPUP' })
    ));
    assert.ok(responses.every(response => response.status === 200));
  }
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '580');
  const history = (await request('/driver/history?limit=100', driverToken)).data.transactions;
  assert.equal(history.total, 80);
  assert.equal(history.items.reduce((sum: number, entry: { amount: string }) => sum + Number(entry.amount), 0), 80);
  assert.deepEqual(history.items.map((entry: { balanceAfter: string }) => Number(entry.balanceAfter)).sort((a: number, b: number) => a - b), Array.from({ length: 80 }, (_, index) => 501 + index));
});

for (const mode of ['public', 'private']) {
  test(`a queued ${mode} claim rechecks positive balance after a concurrent withdrawal commits`, async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  const created = mode === 'public' ? await order() : (await request('/admin/orders', adminToken, {
    districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: driver.id
  })).data;
  let release!: () => void;
  let locked!: (pid: number) => void;
  const ready = new Promise<number>(resolve => { locked = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const heldWallet = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM balances WHERE user_id = ${driver.userId} FOR UPDATE`;
    const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    locked(connection.pid);
    await gate;
  }, { timeout: 10000 });
  async function blockedBy(pid: number) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const waiting = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`;
      if (waiting.length) return waiting[0].pid;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Concurrent request did not reach its database lock');
  }
  let withdrawal: ReturnType<typeof request> | undefined;
  let claim: ReturnType<typeof request> | undefined;
  try {
    const walletPid = await ready;
    withdrawal = request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: -500, type: 'WITHDRAWAL' });
    const withdrawalPid = await blockedBy(walletPid);
    claim = request(mode === 'public' ? '/orders/accept' : '/orders/private-offer/accept', driverToken, { orderId: created.id, ...(mode === 'private' ? { privateOfferExpiresAt: created.privateOfferExpiresAt } : {}) });
    await blockedBy(withdrawalPid);
  } finally {
    release();
    await heldWallet;
  }
  assert.equal((await withdrawal!).status, 200);
  assert.equal((await claim!).status, 403);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '0');
  assert.equal((await request('/orders/current', driverToken)).data, null);
  const history = (await request('/driver/history', driverToken)).data.transactions;
  assert.equal(history.total, 1);
  assert.equal(history.items[0].amount, '-500');
  });
}

test('topups racing order charges and refunds reconcile through public history', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  for (let round = 0; round < 20; round++) {
    const created = await order();
    const responses = await Promise.all([
      request('/orders/accept', driverToken, { orderId: created.id }),
      request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 1, type: 'TOPUP' })
    ]);
    assert.ok(responses.every(response => response.status === 200));
    assert.equal((await request('/driver/balance', driverToken)).data.amount, String(491 + round * 2));
    const cancelled = await Promise.all([
      request('/orders/cancel', driverToken, { orderId: created.id }),
      request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 1, type: 'TOPUP' })
    ]);
    assert.ok(cancelled.every(response => response.status === 200));
    assert.equal((await request('/driver/balance', driverToken)).data.amount, String(502 + round * 2));
  }
  const history = (await request('/driver/history?limit=100', driverToken)).data.transactions;
  assert.equal(history.total, 80);
  assert.equal(history.items.filter((entry: { type: string }) => entry.type === 'PAYMENT').length, 20);
  assert.equal(history.items.filter((entry: { type: string }) => entry.type === 'REFUND').length, 20);
  assert.equal(history.items.reduce((sum: number, entry: { amount: string }) => sum + Number(entry.amount), 0), 40);
});

test('concurrent withdrawals recheck funds without creating a forbidden ledger entry', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  const responses = await Promise.all(Array.from({ length: 2 }, () =>
    request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: -400, type: 'WITHDRAWAL' })
  ));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '100');
  const history = (await request('/driver/history', driverToken)).data.transactions;
  assert.equal(history.total, 1);
  assert.equal(history.items[0].amount, '-400');
  assert.equal(history.items[0].balanceAfter, '100');
});

test('a failed ledger insert rolls back the claim and wallet before a safe retry', async () => {
  const created = await order();
  const client = await socket(adminToken);
  const payments: unknown[] = [];
  client.on('balance:updated', event => { if (event.orderId === created.id) payments.push(event); });
  // A storage-boundary failure fixture, confined to this disposable schema.
  await prisma.$executeRawUnsafe('ALTER TABLE transactions ADD CONSTRAINT fail_test_payment CHECK (amount <> -10)');
  try {
    assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 500);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
    assert.equal((await request('/orders/current', driverToken)).data, null);
    assert.equal((await request('/driver/profile', driverToken)).data.isAvailable, true);
    assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 0);
    assert.equal(payments.length, 0);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE transactions DROP CONSTRAINT fail_test_payment');
  }
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 200);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '490');
  const history = (await request('/driver/history', driverToken)).data.transactions;
  assert.equal(history.total, 1);
  assert.equal(history.items[0].amount, '-10');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(payments.length, 1);
  client.disconnect();
});

test('private offers reserve cross-region orders without disclosing phone or charging until acceptance', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const result = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: driver.id });
  assert.equal(result.status, 201);
  assert.equal(result.data.privateOfferDriverId, driver.id);
  const pending = await request('/orders/private-offer', otherToken);
  assert.equal(pending.status, 200);
  assert.equal(pending.data.id, result.data.id);
  assert.equal(pending.data.clientPhone, undefined);
  assert.ok(Date.parse(pending.data.privateOfferExpiresAt) > Date.now());
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '500');
  assert.deepEqual((await request('/orders/available', driverToken)).data, []);
  assert.equal((await request('/orders/accept', driverToken, { orderId: result.data.id })).status, 409);
  const accepted = await request('/orders/private-offer/accept', otherToken, { orderId: result.data.id, privateOfferExpiresAt: pending.data.privateOfferExpiresAt });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.clientPhone, '+99365000000');
  assert.equal(accepted.data.districtId, regionId);
  assert.equal((await request('/driver/profile', otherToken)).data.districtId, driver.districtId);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '490');
});

test('declining a private offer releases it publicly and an old response cannot decline a newer reservation', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const created = await order();
  const offered = await request(`/admin/orders/${created.id}/private-offer`, adminToken, { driverId: driver.id });
  assert.equal(offered.status, 200);
  const deadline = offered.data.privateOfferExpiresAt;
  assert.equal((await request('/orders/private-offer/decline', driverToken, { orderId: created.id, privateOfferExpiresAt: deadline })).status, 409);
  assert.equal((await request('/orders/private-offer/decline', otherToken, { orderId: created.id, privateOfferExpiresAt: deadline })).status, 200);
  assert.equal((await request(`/orders/available?districtId=${regionId}`, driverToken)).data[0].id, created.id);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '500');
  const renewed = await request(`/admin/orders/${created.id}/private-offer`, adminToken, { driverId: driver.id });
  assert.equal(renewed.status, 200);
  assert.notEqual(renewed.data.privateOfferExpiresAt, deadline);
  assert.equal((await request('/orders/private-offer/decline', otherToken, { orderId: created.id, privateOfferExpiresAt: deadline })).status, 409);
  assert.equal((await request('/orders/private-offer', otherToken)).data.privateOfferExpiresAt, renewed.data.privateOfferExpiresAt);
});

test('private offer deadline survives recovery and expires to its regional queue without a debit', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const target = await socket(otherToken);
  const received = nextSocketEvent<{ id: string; privateOfferExpiresAt: string; privateOfferRemainingMs: number; clientPhone?: string }>(target, 'order:private-offer');
  const created = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: driver.id });
  assert.equal(created.status, 201);
  const notification = await received;
  assert.equal(notification.id, created.data.id);
  assert.equal(notification.clientPhone, undefined);
  assert.ok(notification.privateOfferRemainingMs > 18_000 && notification.privateOfferRemainingMs <= 20_000);
  const deadline = notification.privateOfferExpiresAt;
  assert.ok(Date.parse(deadline) - Date.now() <= 20_000);
  assert.ok(Date.parse(deadline) - Date.now() > 18_000);
  target.disconnect();
  const recovered = await request('/orders/private-offer', otherToken);
  assert.equal(recovered.data.privateOfferExpiresAt, deadline);
  const reconnected = await socket(otherToken);
  const ended = nextSocketEvent<{ orderId: string; privateOfferExpiresAt: string }>(reconnected, 'order:private-offer-ended', 23_000);
  const end = await ended;
  assert.equal(end.orderId, created.data.id);
  assert.equal(end.privateOfferExpiresAt, deadline);
  assert.equal((await request('/orders/private-offer', otherToken)).data, null);
  assert.equal((await request('/orders/private-offer/accept', otherToken, { orderId: created.data.id, privateOfferExpiresAt: deadline })).status, 409);
  assert.equal((await request(`/orders/available?districtId=${regionId}`, driverToken)).data[0].id, created.data.id);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '500');
});

test('one driver cannot claim two different orders concurrently and a pending offer blocks public claims', async () => {
  const first = await order();
  const second = await order();
  const results = await Promise.all([first, second].map(item => request('/orders/accept', driverToken, { orderId: item.id })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '490');
  const driver = (await request('/driver/profile', otherToken)).data;
  const pending = await order();
  assert.equal((await request(`/admin/orders/${pending.id}/private-offer`, adminToken, { driverId: driver.id })).status, 200);
  const another = await order();
  assert.equal((await request('/orders/accept', otherToken, { orderId: another.id })).status, 409);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '500');
});

test('competing reservations and public claims have one winner and never double charge', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const first = await order();
  const second = await order();
  const reservations = await Promise.all([first, second].map(item => request(`/admin/orders/${item.id}/private-offer`, adminToken, { driverId: driver.id })));
  assert.deepEqual(reservations.map(result => result.status).sort(), [200, 409]);
  const reserved = reservations.find(result => result.status === 200)!.data;
  const claims = await Promise.all([
    request('/orders/private-offer/accept', otherToken, { orderId: reserved.id, privateOfferExpiresAt: reserved.privateOfferExpiresAt }),
    request('/orders/accept', driverToken, { orderId: reserved.id }),
    request('/orders/private-offer/accept', otherToken, { orderId: reserved.id, privateOfferExpiresAt: reserved.privateOfferExpiresAt })
  ]);
  assert.deepEqual(claims.map(result => result.status).sort(), [200, 409, 409]);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '490');
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  assert.equal((await request(`/admin/orders/${first.id === reserved.id ? second.id : first.id}/private-offer`, adminToken, { driverId: driver.id })).status, 409);
});

test('private offers reject offline, stale GPS, blocked, busy and zero-balance drivers without reserving', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const created = await order();
  for (const data of [{ isOnline: false }, { lastLocationAt: new Date(Date.now() - 61_000) }, { status: 'BLOCKED' }, { isAvailable: false }]) {
    await prisma.driver.update({ where: { id: driver.id }, data: { isOnline: true, isAvailable: true, status: 'APPROVED', lastLocationAt: new Date(), ...data } as Prisma.DriverUpdateInput });
    const result = await request(`/admin/orders/${created.id}/private-offer`, adminToken, { driverId: driver.id });
    assert.ok([403, 409].includes(result.status));
  }
  await prisma.driver.update({ where: { id: driver.id }, data: { isOnline: true, isAvailable: true } });
  await prisma.balance.update({ where: { userId: driver.userId }, data: { amount: 0 } });
  assert.equal((await request(`/admin/orders/${created.id}/private-offer`, adminToken, { driverId: driver.id })).status, 409);
  assert.equal((await request(`/orders/available?districtId=${regionId}`, driverToken)).data[0].id, created.id);
});

test('dispatcher cancellation immediately dismisses a reserved offer without charging the driver', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const target = await socket(otherToken);
  const created = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: driver.id });
  assert.equal(created.status, 201);
  const ended = nextSocketEvent<{ orderId: string }>(target, 'order:private-offer-ended', 1000);
  assert.equal((await request(`/admin/orders/${created.data.id}/cancel`, adminToken, {})).status, 200);
  assert.equal((await ended).orderId, created.data.id);
  assert.equal((await request('/orders/private-offer', otherToken)).data, null);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '500');
});

test('a reserved driver who becomes unavailable cannot accept or debit the balance', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const created = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: driver.id });
  assert.equal(created.status, 201);
  assert.equal((await request('/driver/status', otherToken, { isAvailable: false })).status, 200);
  assert.equal((await request('/orders/private-offer/accept', otherToken, { orderId: created.data.id, privateOfferExpiresAt: created.data.privateOfferExpiresAt })).status, 409);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '500');
});

test('a same-region existing-order reservation removes the public offer only for other drivers', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  assert.equal((await request('/driver/location', otherToken, { lat: 37.96, lng: 58.32 })).status, 200);
  const target = await socket(driverToken);
  const other = await socket(otherToken);
  const created = await request('/admin/orders', adminToken, { districtId: driver.districtId, priceEstimated: 10, clientPhone: '+99365000000' });
  assert.equal(created.status, 201);
  const targetTaken: unknown[] = [];
  target.on('order:taken', event => targetTaken.push(event));
  const received = nextSocketEvent<{ id: string }>(target, 'order:private-offer');
  const removedForOther = nextSocketEvent<{ orderId: string }>(other, 'order:taken');
  assert.equal((await request(`/admin/orders/${created.data.id}/private-offer`, adminToken, { driverId: driver.id })).status, 200);
  assert.equal((await received).id, created.data.id);
  assert.equal((await removedForOther).orderId, created.data.id);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(targetTaken, []);
  assert.equal((await request('/orders/private-offer', driverToken)).data.id, created.data.id);
});

test('a private acceptance blocked by database contention cannot cross the server deadline', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const created = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: driver.id });
  assert.equal(created.status, 201);
  // Fixture: move the already elapsed portion of the window forward, then
  // hold a real database write lock to model a delayed competing operation.
  const deadline = new Date(Date.now() + 1500);
  await prisma.order.update({ where: { id: created.data.id }, data: { privateOfferExpiresAt: deadline } });
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const blocker = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${created.data.id} FOR UPDATE`;
    locked();
    await gate;
  });
  try {
    await ready;
    const accepting = request('/orders/private-offer/accept', otherToken, { orderId: created.data.id, privateOfferExpiresAt: deadline.toISOString() });
    await new Promise(resolve => setTimeout(resolve, 2000));
    release();
    await blocker;
    assert.equal((await accepting).status, 409);
    assert.equal((await request('/driver/balance', otherToken)).data.amount, '500');
  } finally { release(); await blocker; }
});

test('dispatcher edits driver identity without a name-only change ending the session', async () => {
  const created = await request('/admin/drivers', adminToken, { fullName: 'Credential fixture', phone: '+99361001001', password });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const login = await request('/auth/login', '', { phone: '+99361001001', password, deviceId: 'credential-test-device' });
  assert.equal(login.status, 200);
  const body = { fullName: 'Updated driver', phone: '+99361001001' };
  assert.equal((await request(`/admin/drivers/${id}/profile`, driverToken, body)).status, 403);
  assert.equal((await request(`/admin/drivers/${id}/profile`, '', body)).status, 401);
  const updated = await request(`/admin/drivers/${id}/profile`, adminToken, body);
  assert.equal(updated.status, 200);
  assert.equal(updated.data.user.fullName, 'Updated driver');
  assert.equal((await request('/driver/profile', login.data.accessToken)).status, 200);
  const duplicate = await request(`/admin/drivers/${id}/profile`, adminToken, { fullName: 'Should not save', phone: '+99360000102' });
  assert.equal(duplicate.status, 409);
  const preserved = await request(`/admin/drivers/${id}`, adminToken);
  assert.equal(preserved.data.user.fullName, 'Updated driver');
  assert.equal(preserved.data.user.phone, '+99361001001');
  assert.equal((await request(`/admin/drivers/${id}/profile`, adminToken, { fullName: 'X', phone: 'bad' })).status, 400);
});

test('changing driver login phone revokes old sessions and keeps approved device, balance and trip', async () => {
  const fixture = await request('/admin/drivers', adminToken, { fullName: 'Phone fixture', phone: '+99361001003', password });
  await request(`/admin/drivers/${fixture.data.id}/balance`, adminToken, { amount: 500, type: 'TOPUP' });
  const session = await request('/auth/login', '', { phone: '+99361001003', password, deviceId: 'credential-device' });
  const profile = await request('/driver/profile', session.data.accessToken);
  const id = profile.data.id;
  const oldSocket = await socket(session.data.accessToken);
  await request('/driver/location', session.data.accessToken, { lat: 37.96, lng: 58.32 });
  await request('/driver/status', session.data.accessToken, { isOnline: true, isAvailable: true });
  const created = await order();
  assert.equal((await request('/orders/accept', session.data.accessToken, { orderId: created.id, arrivalMinutes: 5 })).status, 200);
  const disconnected = socketEvent(oldSocket, 'disconnect');
  const result = await request(`/admin/drivers/${id}/profile`, adminToken, { fullName: 'New identity', phone: '+99361001002' });
  assert.equal(result.status, 200);
  await disconnected;
  assert.equal((await request('/driver/profile', session.data.accessToken)).status, 401);
  assert.equal((await request('/auth/refresh', '', { refreshToken: session.data.refreshToken })).status, 401);
  assert.equal((await request('/auth/login', '', { phone: '+99361001003', password })).status, 401);
  const recovered = await request('/auth/login', '', { phone: '+99361001002', password, deviceId: 'credential-device' });
  assert.equal(recovered.status, 200);
  const restored = await request('/driver/profile', recovered.data.accessToken);
  assert.equal(restored.data.currentDeviceId, 'credential-device');
  assert.equal(restored.data.isOnline, false);
  assert.equal((await request('/driver/balance', recovered.data.accessToken)).data.amount, '490');
  assert.equal((await request('/orders/current', recovered.data.accessToken)).data.id, created.id);
  const rejected = connect(base, { auth: { token: session.data.accessToken }, transports: ['websocket'], reconnection: false });
  clients.push(rejected);
  const [error] = await socketEvent(rejected, 'connect_error');
  assert.equal(error.message, 'unauthorized');
});

test('dispatcher resets driver password with confirmation and revokes all prior refresh generations', async () => {
  await request('/admin/drivers', adminToken, { fullName: 'Password fixture', phone: '+99361001004', password });
  const session = await request('/auth/login', '', { phone: '+99361001004', password });
  const rotated = await request('/auth/refresh', '', { refreshToken: session.data.refreshToken });
  const id = (await request('/driver/profile', session.data.accessToken)).data.id;
  const body = { password: 'Replacement123!', passwordConfirmation: 'Replacement123!' };
  assert.equal((await request(`/admin/drivers/${id}/password`, driverToken, body)).status, 403);
  assert.equal((await request(`/admin/drivers/${id}/password`, adminToken, { ...body, passwordConfirmation: 'mismatch' })).status, 400);
  assert.equal((await request(`/admin/drivers/${id}/password`, adminToken, { password: 'short', passwordConfirmation: 'short' })).status, 400);
  assert.equal((await request('/driver/profile', session.data.accessToken)).status, 200);
  const reset = await request(`/admin/drivers/${id}/password`, adminToken, body);
  assert.equal(reset.status, 200);
  assert.equal(JSON.stringify(reset.data).includes('Replacement'), false);
  assert.equal(JSON.stringify(reset.data).includes('passwordHash'), false);
  for (const token of [session.data.refreshToken, rotated.data.refreshToken])
    assert.equal((await request('/auth/refresh', '', { refreshToken: token })).status, 401);
  assert.equal((await request('/driver/profile', rotated.data.accessToken)).status, 401);
  assert.equal((await request('/auth/login', '', { phone: '+99361001004', password })).status, 401);
  assert.equal((await request('/auth/login', '', { phone: '+99361001004', password: body.password })).status, 200);
});

test('a credential change keeps the driver offline when an old online request is already in flight', async () => {
  const fixture = await request('/admin/drivers', adminToken, { fullName: 'Concurrent credential fixture', phone: '+99361001005', password });
  const session = await request('/auth/login', '', { phone: '+99361001005', password });
  const token = session.data.accessToken;
  await request('/driver/location', token, { lat: 37.96, lng: 58.32 });
  // Fixture database locks arrange an in-flight request; assertions stay at HTTP seams.
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { ready = resolve; });
  const blocker = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${fixture.data.id} FOR UPDATE`;
    ready();
    await gate;
  }, { timeout: 10000 });
  async function waitForBlockedRequests(count: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (Number(rows[0].count) >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Fixture did not arrange the concurrent HTTP requests');
  }
  await locked;
  let changed!: Awaited<ReturnType<typeof request>>;
  let online!: Awaited<ReturnType<typeof request>>;
  try {
    const reset = request(`/admin/drivers/${fixture.data.id}/profile`, adminToken, { fullName: 'Concurrent credential fixture', phone: '+99361001006' });
    await waitForBlockedRequests(1);
    const oldRequest = request('/driver/status', token, { isOnline: true });
    await waitForBlockedRequests(2);
    release();
    [changed, online] = await Promise.all([reset, oldRequest]);
  } finally {
    release();
    await blocker;
  }
  assert.equal(changed.status, 200);
  assert.equal(online.status, 401);
  const final = await request(`/admin/drivers/${fixture.data.id}`, adminToken);
  assert.equal(final.data.isOnline, false);
});

test('credential reset revokes a private offer session while the new login can recover and confirm it', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const created = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: driver.id });
  assert.equal(created.status, 201);
  const reset = await request(`/admin/drivers/${driver.id}/password`, adminToken, { password: 'SyntheticReplacement123!', passwordConfirmation: 'SyntheticReplacement123!' });
  assert.equal(reset.status, 200);
  assert.equal((await request('/orders/private-offer', otherToken)).status, 401);
  assert.equal((await request('/orders/private-offer/accept', otherToken, { orderId: created.data.id, privateOfferExpiresAt: created.data.privateOfferExpiresAt })).status, 401);
  const session = await request('/auth/login', '', { phone: '+99360000102', password: 'SyntheticReplacement123!' });
  assert.equal(session.status, 200);
  const token = session.data.accessToken;
  assert.equal((await request('/orders/private-offer', token)).status, 403);
  assert.equal((await request('/driver/location', token, { lat: 37.96, lng: 58.42 })).status, 200);
  assert.equal((await request('/driver/status', token, { isOnline: true })).status, 200);
  const recovered = await request('/orders/private-offer', token);
  assert.equal(recovered.data.id, created.data.id);
  assert.equal(recovered.data.privateOfferExpiresAt, created.data.privateOfferExpiresAt);
  assert.equal(recovered.data.clientPhone, undefined);
  assert.equal((await request('/driver/balance', token)).data.amount, '500');
  assert.equal((await request('/orders/private-offer/accept', token, { orderId: recovered.data.id, privateOfferExpiresAt: recovered.data.privateOfferExpiresAt })).status, 200);
  assert.equal((await request('/driver/balance', token)).data.amount, '490');
  assert.equal((await request('/orders/current', token)).data.id, created.data.id);
  otherToken = token;
});

test('credential reset cannot revive an old native shift after the new session goes online', async () => {
  const phone = '+99361001090';
  const created = await request('/admin/drivers', adminToken, { fullName: 'Native credential fixture', phone, password });
  const id = created.data.id;
  assert.equal((await request(`/admin/drivers/${id}/balance`, adminToken, { amount: 500, type: 'TOPUP' })).status, 200);
  const auth = await request('/auth/login', '', { phone, password, deviceId: 'native-credential-device' });
  const token = auth.data.accessToken;
  await request('/driver/location', token, { lat: 37.96, lng: 58.32 });
  await request('/driver/status', token, { isOnline: true });
  const started = await request('/driver/shift', token, { deviceId: 'native-credential-device', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  const changedPassword = 'UpdatedNative123!';
  assert.equal((await request(`/admin/drivers/${id}/password`, adminToken, { password: changedPassword, passwordConfirmation: changedPassword })).status, 200);
  const fresh = await request('/auth/login', '', { phone, password: changedPassword, deviceId: 'native-credential-device' });
  assert.equal(fresh.status, 200);
  await request('/driver/location', fresh.data.accessToken, { lat: 37.96, lng: 58.32 });
  await request('/driver/status', fresh.data.accessToken, { isOnline: true });
  assert.equal((await request('/native-shift/tick', started.data.shiftToken, { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() })).status, 401);
});

test('native private offer replay preserves the persisted deadline and acceptance removes its notification', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'native-test-device' });
  assert.equal(auth.status, 200);
  const token = auth.data.accessToken;
  const started = await request('/driver/shift', token, { deviceId: 'native-test-device', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  const profile = (await request('/driver/profile', token)).data;
  const offered = await request('/admin/orders', adminToken, { districtId: otherRegionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: profile.id });
  assert.equal(offered.status, 201);
  const fix = () => ({ lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() });
  const first = await request('/native-shift/tick', started.data.shiftToken, fix());
  const event = first.data.events.find((item: { orderId?: string }) => item.orderId === offered.data.id);
  assert.equal(event.expiresAt, offered.data.privateOfferExpiresAt);
  assert.equal(event.id, `private:${offered.data.id}:${offered.data.privateOfferExpiresAt}`);
  assert.equal(JSON.stringify(first.data.events).includes('+99365000000'), false);
  const replay = await request('/native-shift/tick', started.data.shiftToken, fix());
  assert.deepEqual(replay.data.events.find((item: { orderId?: string }) => item.orderId === offered.data.id), event);
  const recovered = await request('/orders/private-offer', token);
  assert.equal(recovered.data.privateOfferExpiresAt, event.expiresAt);
  assert.equal((await request('/orders/private-offer/accept', token, { orderId: offered.data.id, privateOfferExpiresAt: event.expiresAt })).status, 200);
  const accepted = await request('/native-shift/tick', started.data.shiftToken, fix());
  assert.equal(accepted.data.events.some((item: { orderId?: string }) => item.orderId === offered.data.id), false);
  assert.equal((await request('/driver/balance', token)).data.amount, '490');
});
test('private confirmation and cancellation preserve credits with one charge and refund', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const created = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: driver.id });
  assert.equal(created.status, 201);
  const confirmation = { orderId: created.data.id, privateOfferExpiresAt: created.data.privateOfferExpiresAt };
  const accepted = await Promise.all([
    request('/orders/private-offer/accept', otherToken, confirmation),
    request('/orders/private-offer/accept', otherToken, confirmation),
    request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 1, type: 'TOPUP' })
  ]);
  assert.deepEqual(accepted.map(response => response.status).sort(), [200, 200, 409]);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '491');
  const cancelled = await Promise.all([
    request('/orders/cancel', otherToken, { orderId: created.data.id }),
    request(`/admin/orders/${created.data.id}/cancel`, adminToken, {}),
    request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 1, type: 'TOPUP' })
  ]);
  assert.deepEqual(cancelled.map(response => response.status).sort(), [200, 200, 409]);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '502');
  const history = (await request('/driver/history', otherToken)).data.transactions;
  assert.equal(history.total, 4);
  assert.equal(history.items.filter((entry: { type: string }) => entry.type === 'PAYMENT').length, 1);
  assert.equal(history.items.filter((entry: { type: string }) => entry.type === 'REFUND').length, 1);
  assert.equal(history.items.reduce((sum: number, entry: { amount: string }) => sum + Number(entry.amount), 0), 2);
});

test('a native renewal blocked beyond lease expiry cannot restore availability', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'native-test-device' });
  assert.equal(auth.status, 200);
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'native-test-device', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  assert.equal(typeof started.data.shiftToken, 'string');
  const profile = (await request('/driver/profile', auth.data.accessToken)).data;
  await prisma.$executeRaw`UPDATE native_shift_leases SET expires_at = NOW() + INTERVAL '600 milliseconds' WHERE driver_id = ${profile.id}`;
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const locked = new Promise<void>(resolve => { ready = resolve; });
  const blocker = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${profile.userId} FOR UPDATE`;
    ready(); await gate;
  }, { timeout: 10000 });
  await locked;
  try {
    const pending = request('/native-shift/tick', started.data.shiftToken, { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() });
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'SELECT u.id FROM users u JOIN drivers d%'`;
      if (Number(rows[0].count) > 0) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, 'native renewal must reach the held user lock before its expiry');
    await new Promise(resolve => setTimeout(resolve, 850));
    release();
    assert.equal((await pending).status, 401);
  } finally { release(); await blocker; }
});

test('numeric six-character driver passwords work consistently for creation and reset while old sessions are revoked', async () => {
  const phone = '+99361001091';
  const created = await request('/admin/drivers', adminToken, { fullName: 'Numeric password fixture', phone, password: '123456' });
  assert.equal(created.status, 201);
  assert.equal((await request(`/admin/drivers/${created.data.id}/balance`, adminToken, { amount: 500, type: 'TOPUP' })).status, 200);
  const auth = await request('/auth/login', '', { phone, password: '123456', deviceId: 'numeric-password-device' });
  assert.equal(auth.status, 200);
  const token = auth.data.accessToken;
  await request('/driver/location', token, { lat: 37.96, lng: 58.32 });
  await request('/driver/status', token, { isOnline: true, isAvailable: true });
  const shift = await request('/driver/shift', token, { deviceId: 'numeric-password-device', refreshToken: auth.data.refreshToken });
  assert.equal(shift.status, 201);
  const connected = await socket(token);
  const revoked = nextSocketEvent(connected, 'session:revoked');
  const reset = await request(`/admin/drivers/${created.data.id}/password`, adminToken, { password: '654321', passwordConfirmation: '654321' });
  assert.equal(reset.status, 200);
  await revoked;
  assert.equal((await request('/driver/profile', token)).status, 401);
  assert.equal((await request('/auth/refresh', '', { refreshToken: auth.data.refreshToken })).status, 401);
  assert.equal((await request('/native-shift/tick', shift.data.shiftToken, { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() })).status, 401);
  assert.equal((await request('/auth/login', '', { phone, password: '123456' })).status, 401);
  assert.equal((await request('/auth/login', '', { phone, password: '654321', deviceId: 'numeric-password-device' })).status, 200);
});

test('new driver passwords reject short values and bcrypt-truncated UTF-8 values in registration, creation and reset', async () => {
  const fixture = await request('/admin/drivers', adminToken, { fullName: 'Password byte limit fixture', phone: '+99361001092', password: '123456' });
  assert.equal(fixture.status, 201);
  for (const invalid of ['12345', 'a'.repeat(73), 'é'.repeat(37)]) {
    for (const path of ['/auth/register', '/admin/drivers']) {
      const result = await request(path, path.startsWith('/admin') ? adminToken : '', { fullName: 'Invalid password fixture', phone: '+99361001093', password: invalid });
      assert.equal(result.status, 400, `${path} rejects invalid new password`);
    }
    const reset = await request(`/admin/drivers/${fixture.data.id}/password`, adminToken, { password: invalid, passwordConfirmation: invalid });
    assert.equal(reset.status, 400);
  }
  assert.equal((await request('/auth/login', '', { phone: '+99361001092', password: '123456' })).status, 200);
});

test('driver registration rejects a UTF-8 password beyond bcrypt 72-byte capacity even when character length is short', async () => {
  const result = await request('/auth/register', '', { fullName: 'UTF-8 limit fixture', phone: '+99361001094', password: 'é'.repeat(37) });
  assert.equal(result.status, 400);
});


test('Turkmen phone inputs normalize formatting and reject other countries or invalid lengths across public writes', async () => {
  const formatted = '+993 61-001095';
  const created = await request('/admin/drivers', adminToken, { fullName: 'Phone policy fixture', phone: formatted, password: '123456' });
  assert.equal(created.status, 201);
  assert.equal(created.data.user.phone, '+99361001095');
  assert.equal((await request('/auth/login', '', { phone: formatted, password: '123456' })).status, 200);
  const invalidPhones = ['+10000000999', '+9936100109', '+993610010950', '61001095', '+99361x01095', '+993+61001095'];
  for (const phone of invalidPhones) {
    assert.equal((await request('/auth/register', '', { fullName: 'Invalid phone', phone, password: '123456' })).status, 400);
    assert.equal((await request('/admin/drivers', adminToken, { fullName: 'Invalid phone', phone, password: '123456' })).status, 400);
    assert.equal((await request(`/admin/drivers/${created.data.id}/profile`, adminToken, { fullName: 'Invalid phone', phone })).status, 400);
    assert.equal((await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: phone })).status, 400);
    assert.equal((await request('/auth/login', '', { phone, password: '123456' })).status, 400);
  }
  const result = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: formatted });
  assert.equal(result.status, 201);
  assert.equal(result.data.clientPhone, '+99361001095');
});


test('dispatcher overview counts the full fleet and decimal completed trip value instead of a page sample', async () => {
  const now = new Date();
  const extraUsers: string[] = [];
  // Earlier workflows create accounts; this measurement example owns a fixed fleet.
  await prisma.user.deleteMany({ where: { role: 'DRIVER', phone: { notIn: ['+99360000101', '+99360000102'] } } });
  try {
    for (let index = 0; index < 107; index++) {
      const user = await prisma.user.create({ data: {
        phone: `+99361${String(index).padStart(6, '0')}`, fullName: `Analytics fixture ${index}`, role: 'DRIVER', passwordHash: 'fixture-only',
        status: index === 106 ? 'BLOCKED' : 'ACTIVE',
        driver: { create: {
          districtId: regionId, status: index === 103 ? 'PENDING' : index === 104 ? 'BLOCKED' : 'APPROVED',
          isOnline: index !== 101, isAvailable: true, lastLat: 37.96, lastLng: 58.32,
          lastLocationAt: new Date(now.getTime() + (index === 102 ? -120000 : index === 105 ? 120000 : 0)),
          createdAt: new Date('2020-01-01T00:00:00Z')
        } }, balance: { create: { amount: 500 } }
      } });
      extraUsers.push(user.id);
    }
    await prisma.order.createMany({ data: [
      ...Array.from({ length: 100 }, () => ({ districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'COMPLETED' as const, priceFinal: '0.10', completedAt: now })),
      { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'COMPLETED', priceEstimated: '0.21', completedAt: now },
      { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'COMPLETED', completedAt: now },
      { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'CANCELLED', priceFinal: '999', cancelledAt: now },
      { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'NEW', priceEstimated: '500' }
    ] });
    const page = await request('/admin/drivers?limit=100', adminToken);
    assert.equal(page.data.total, 109);
    assert.equal(page.data.items.length, 100);
    assert.notEqual(page.data.items.filter((driver: { isOnline: boolean }) => driver.isOnline).length, 103);
    const result = await request('/admin/overview', adminToken);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, {
      totalDrivers: 109, onlineDrivers: 103, pendingDrivers: 1, activeOrders: 1,
      completedTrips: 102, pricedCompletedTrips: 101, completedTripValue: '10.21', averageCompletedTripValue: '0.10'
    });
    const districts = await request('/districts', adminToken);
    const district = districts.data.find((item: { id: string }) => item.id === regionId);
    assert.equal(district.onlineDrivers, 102);
    assert.equal(district.freeDrivers, 102);
  } finally {
    await prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
  }
});

test('dispatcher overview protects roles and distinguishes empty, unknown and zero-priced trips', async () => {
  assert.equal((await request('/admin/overview')).status, 401);
  assert.equal((await request('/admin/overview', driverToken)).status, 403);
  const empty = await request('/admin/overview', adminToken);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.completedTrips, 0);
  assert.equal(empty.data.pricedCompletedTrips, 0);
  assert.equal(empty.data.completedTripValue, '0.00');
  assert.equal(empty.data.averageCompletedTripValue, '0.00');
  const now = new Date();
  await prisma.order.createMany({ data: [
    { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'COMPLETED', priceFinal: 0, priceEstimated: 50, completedAt: now },
    { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'COMPLETED', priceFinal: '0.20', priceEstimated: 100, completedAt: now },
    { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'COMPLETED', completedAt: now }
  ] });
  const result = await request('/admin/overview', adminToken);
  assert.equal(result.data.completedTrips, 3);
  assert.equal(result.data.pricedCompletedTrips, 2);
  assert.equal(result.data.completedTripValue, '0.20');
  assert.equal(result.data.averageCompletedTripValue, '0.10');
  await prisma.driver.updateMany({ where: { user: { phone: '+99360000101' } }, data: { isAvailable: false } });
  const busy = await request('/admin/overview', adminToken);
  assert.equal(busy.data.onlineDrivers, 2, 'busy drivers remain part of the online fleet');
  const districts = await request('/districts', adminToken);
  const district = districts.data.find((item: { id: string }) => item.id === regionId);
  assert.equal(district.onlineDrivers, 1);
  assert.equal(district.freeDrivers, 0);
});

test('dispatcher overview invalidates live counts after approval, unblock and account deletion', async () => {
  const user = await prisma.user.create({ data: { role: 'DRIVER', phone: '+99361999990', fullName: 'Analytics pending driver', passwordHash: 'fixture-only', driver: { create: { status: 'PENDING' } } }, include: { driver: true } });
  const client = await socket(adminToken);
  try {
    assert.equal((await request('/admin/overview', adminToken)).data.pendingDrivers, 1);
    const approved = nextSocketEvent(client, 'districts:stats', 500);
    assert.equal((await request(`/admin/drivers/${user.driver!.id}/approve`, adminToken, {})).status, 200);
    await approved;
    assert.equal((await request('/admin/overview', adminToken)).data.pendingDrivers, 0);
    assert.equal((await request(`/admin/drivers/${user.driver!.id}/block`, adminToken, {})).status, 200);
    const unblocked = nextSocketEvent(client, 'districts:stats', 500);
    assert.equal((await request(`/admin/drivers/${user.driver!.id}/unblock`, adminToken, {})).status, 200);
    await unblocked;
    const removed = nextSocketEvent(client, 'districts:stats', 500);
    const response = await fetch(`${base}/admin/drivers/${user.driver!.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(response.status, 204);
    await removed;
    assert.equal((await request('/admin/overview', adminToken)).data.totalDrivers, 2);
  } finally {
    client.disconnect();
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
});

test('self-registration refreshes admin overview counts without exposing the application to drivers', async () => {
  const admin = await socket(adminToken);
  const driver = await socket(driverToken);
  const leaked: unknown[] = [];
  driver.on('driver:registered', payload => leaked.push(payload));
  try {
    const before = await request('/admin/overview', adminToken);
    const registered = nextSocketEvent<{ driverId: string }>(admin, 'driver:registered');
    // Attach rejection handling immediately while the HTTP request is in flight.
    const notification = registered.then(value => ({ value }), error => ({ error }));
    const response = await request('/auth/register', '', {
      phone: '+99361999888', fullName: 'Pending overview applicant', password: '123456'
    });
    assert.equal(response.status, 201);
    const result = await notification;
    assert.ok('value' in result, 'admin must receive registration invalidation after the account is committed');
    assert.deepEqual(result.value, { driverId: response.data.user.driver.id });
    const overview = await request('/admin/overview', adminToken);
    assert.equal(overview.data.totalDrivers, before.data.totalDrivers + 1);
    assert.equal(overview.data.pendingDrivers, before.data.pendingDrivers + 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(leaked, [], 'driver sockets must not receive applicant registration events');
  } finally {
    admin.disconnect();
    driver.disconnect();
    await prisma.user.deleteMany({ where: { phone: '+99361999888' } });
  }
});


test('an underfunded driver sees public work but cannot accept or create a negative balance', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  await prisma.balance.update({ where: { userId: driver.userId }, data: { amount: 15 } });
  const created = await order(30);
  const available = await request(`/orders/available?districtId=${regionId}`, driverToken);
  assert.ok(available.data.some((item: { id: string }) => item.id === created.id));
  const rejected = await request('/orders/accept', driverToken, { orderId: created.id, arrivalMinutes: 5 });
  assert.equal(rejected.status, 403);
  assert.match(rejected.data.message, /баланс|средств/i);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '15');
  assert.equal((await request('/orders/current', driverToken)).data, null);
  const stillAvailable = await request(`/orders/available?districtId=${regionId}`, otherToken);
  assert.ok(stillAvailable.data.some((item: { id: string }) => item.id === created.id));
  assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 0);
});


test('underfunded private creation and reoffer reject without a reservation, charge or fanout', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  await prisma.balance.update({ where: { userId: driver.userId }, data: { amount: 15 } });
  const recipient = await socket(otherToken);
  const received: unknown[] = [];
  recipient.on('order:private-offer', payload => received.push(payload));
  try {
    const created = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 30, clientPhone: '+99365000000', privateOfferDriverId: driver.id });
    assert.equal(created.status, 409);
    assert.equal((await request('/admin/orders', adminToken)).data.total, 0);
    const publicOrder = await order(30);
    const offered = await request(`/admin/orders/${publicOrder.id}/private-offer`, adminToken, { driverId: driver.id });
    assert.equal(offered.status, 409);
    assert.equal((await request('/orders/private-offer', otherToken)).data, null);
    assert.ok((await request(`/orders/available?districtId=${regionId}`, driverToken)).data.some((item: { id: string }) => item.id === publicOrder.id));
    assert.equal((await request('/driver/balance', otherToken)).data.amount, '15');
    assert.equal((await request('/driver/history', otherToken)).data.transactions.total, 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(received, []);
  } finally { recipient.disconnect(); }
});


test('zero and negative balances cannot go online while offline writes remain available', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  for (const amount of [0, -1]) {
    assert.equal((await request('/driver/status', driverToken, { isOnline: false })).status, 200);
    await prisma.balance.update({ where: { userId: driver.userId }, data: { amount } });
    const online = await request('/driver/status', driverToken, { isOnline: true });
    assert.equal(online.status, 403);
    assert.match(online.data.message, /баланс/i);
    assert.equal((await request('/driver/profile', driverToken)).data.isOnline, false);
    assert.equal((await request('/driver/status', driverToken, { isOnline: false })).status, 200);
  }
});


test('an exact quoted balance accepts once and zero balance preserves trip controls', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  await prisma.balance.update({ where: { userId: driver.userId }, data: { amount: 30 } });
  const created = await order(30);
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id, arrivalMinutes: 5 })).status, 200);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '0');
  assert.equal((await request('/driver/status', driverToken, { isOnline: false })).status, 200);
  assert.equal((await request('/driver/status', driverToken, { isOnline: true })).status, 403);
  assert.equal((await request('/orders/current', driverToken)).data.id, created.id);
  for (const action of ['waiting', 'start', 'complete']) {
    assert.equal((await request(`/orders/${action}`, driverToken, { orderId: created.id })).status, 200);
  }
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '0');
  assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 1);
  const next = await order(30);
  assert.equal((await request('/orders/accept', driverToken, { orderId: next.id, arrivalMinutes: 5 })).status, 403);
});

test('concurrent distinct thirty TMT claims cannot overdraw thirty-five TMT', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  await prisma.balance.update({ where: { userId: driver.userId }, data: { amount: 35 } });
  const first = await order(30), second = await order(30);
  const results = await Promise.all([first, second].map(item => request('/orders/accept', driverToken, { orderId: item.id, arrivalMinutes: 5 })));
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '5');
  assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 1);
  assert.equal((await request(`/orders/available?districtId=${regionId}`, otherToken)).data.length, 1);
});

test('private acceptance rechecks funds after reservation without debiting an underfunded driver', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  await prisma.balance.update({ where: { userId: driver.userId }, data: { amount: 30 } });
  const created = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 30, clientPhone: '+99365000000', privateOfferDriverId: driver.id });
  assert.equal(created.status, 201);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '30');
  assert.equal((await request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: -15, type: 'WITHDRAWAL' })).status, 200);
  const result = await request('/orders/private-offer/accept', otherToken, { orderId: created.data.id, privateOfferExpiresAt: created.data.privateOfferExpiresAt });
  assert.equal(result.status, 403);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '15');
  assert.equal((await request('/orders/current', otherToken)).data, null);
  assert.equal((await request('/orders/private-offer', otherToken)).data.id, created.data.id);
  const history = (await request('/driver/history', otherToken)).data.transactions;
  assert.equal(history.total, 1);
  assert.equal(history.items[0].orderId, null);
});

test('chat retries with one client message id persist one message and reject changed content', async () => {
  await prisma.message.deleteMany();
  await prisma.driver.updateMany({ data: { lastChatReadAt: null, lastChatReadMessageId: null, lastReadByAdminAt: null, lastReadByAdminMessageId: null } });
  const clientMessageId = 'd07ca5bb-c21f-4617-a03b-f538d1873096';
  const results = await Promise.all([
    request('/driver/messages', driverToken, { body: 'One delivery', clientMessageId }),
    request('/driver/messages', driverToken, { body: 'One delivery', clientMessageId }),
  ]);
  assert.equal(results[0].status, 201);
  assert.equal(results[1].status, 201);
  assert.equal(results[0].data.id, results[1].data.id);
  const history = (await request('/driver/messages', driverToken)).data;
  assert.equal(history.items.filter((message: { body: string }) => message.body === 'One delivery').length, 1);
  assert.equal((await request('/driver/messages', driverToken, { body: 'Changed delivery', clientMessageId })).status, 409);
});

test('read cursor preserves newer unseen driver and dispatcher messages as unread', async () => {
  await prisma.message.deleteMany();
  await prisma.driver.updateMany({ data: { lastChatReadAt: null, lastChatReadMessageId: null, lastReadByAdminAt: null, lastReadByAdminMessageId: null } });
  const driver = (await request('/driver/profile', driverToken)).data;
  const first = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Visible admin message' });
  await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Unseen admin message' });
  assert.equal((await request('/driver/messages/read', driverToken, { throughMessageId: first.data.id })).status, 204);
  assert.equal((await request('/driver/messages', driverToken)).data.unread, 1);
  const visible = await request('/driver/messages', driverToken, { body: 'Visible driver message' });
  await request('/driver/messages', driverToken, { body: 'Unseen driver message' });
  assert.equal((await request(`/admin/drivers/${driver.id}/messages/read`, adminToken, { throughMessageId: visible.data.id })).status, 204);
  assert.ok((await request('/admin/messages/unread', adminToken)).data.driverIds.includes(driver.id));
});

test('tied chat timestamps keep unseen messages unread and keyset pages complete', async () => {
  await prisma.message.deleteMany();
  await prisma.driver.updateMany({ data: { lastChatReadAt: null, lastChatReadMessageId: null, lastReadByAdminAt: null, lastReadByAdminMessageId: null } });
  const driver = (await request('/driver/profile', driverToken)).data;
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
  const sentAt = new Date('2026-01-01T12:00:00.123Z');
  const ids = ['10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003'];
  await prisma.message.createMany({ data: ids.map(id => ({ id, senderId: admin.id, receiverId: driver.userId, body: id, sentAt })) });
  assert.equal((await request('/driver/messages/read', driverToken, { throughMessageId: ids[0] })).status, 204);
  assert.equal((await request('/driver/messages', driverToken)).data.unread, 2);
  const newest = (await request('/driver/messages?limit=2', driverToken)).data;
  assert.deepEqual(newest.items.map((item: { id: string }) => item.id), [ids[1], ids[2]]);
  const older = (await request(`/driver/messages?limit=2&beforeMessageId=${ids[1]}`, driverToken)).data;
  assert.deepEqual(older.items.map((item: { id: string }) => item.id), [ids[0]]);
  assert.equal((await request('/driver/messages/read', driverToken, { throughMessageId: ids[2] })).status, 204);
  assert.equal((await request('/driver/messages/read', driverToken, { throughMessageId: ids[0] })).status, 204);
  assert.equal((await request('/driver/messages', driverToken)).data.unread, 0);

  const replies = ['20000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002'];
  await prisma.message.createMany({ data: replies.map(id => ({ id, senderId: driver.userId, body: id, sentAt })) });
  assert.equal((await request(`/admin/drivers/${driver.id}/messages/read`, adminToken, { throughMessageId: replies[0] })).status, 204);
  assert.ok((await request('/admin/messages/unread', adminToken)).data.driverIds.includes(driver.id));
  const adminOlder = (await request(`/admin/drivers/${driver.id}/messages?limit=2&beforeMessageId=${replies[0]}`, adminToken)).data;
  assert.deepEqual(adminOlder.items.map((item: { id: string }) => item.id), [ids[1], ids[2]]);
});
