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
  const region = await prisma.district.create({ data: { name: 'Synthetic west', centerLat: 37.96, centerLng: 58.32, boundary: [[[37.94, 58.30], [37.98, 58.30], [37.98, 58.36], [37.94, 58.36]]] } });
  const otherRegion = await prisma.district.create({ data: { name: 'Synthetic east', centerLat: 37.96, centerLng: 58.42, boundary: [[[37.94, 58.38], [37.98, 58.38], [37.98, 58.46], [37.94, 58.46]]] } });
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
  const duplicate = await request(`/admin/drivers/${id}/profile`, adminToken, { fullName: 'Should not save', phone: '+10000000102' });
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
  const session = await request('/auth/login', '', { phone: '+10000000102', password: 'SyntheticReplacement123!' });
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
