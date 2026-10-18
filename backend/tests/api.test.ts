import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
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
    ...(body === undefined ? {} : { body: JSON.stringify(/\/admin\/drivers\/[^/]+\/balance$/.test(path) && body && typeof body === 'object' ? { operationId: randomUUID(), ...body } : body) })
  });
  const data = response.status === 204 ? null : await response.json();
  return { status: response.status, data };
}
async function login(phone: string) {
  const result = await request('/auth/login', '', { phone, password, deviceId: 'synthetic-approved-browser' });
  assert.equal(result.status, 200);
  return result.data.accessToken as string;
}
async function startShift(token: string, lng = 58.32, extra: Record<string, unknown> = {}) {
  return request('/driver/status', token, { isOnline: true, isAvailable: true,
    position: { lat: 37.96, lng, capturedAt: Date.now() }, ...extra });
}
async function withFakeFcm(run: (sent: Array<{ token: string; data: { eventId: string } }>) => Promise<void>, beforeRespond?: () => Promise<void>) {
  const previous = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const realFetch = globalThis.fetch;
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'synthetic-notifications', client_email: `${randomUUID()}@synthetic.iam.gserviceaccount.com`, private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() });
  const sent: Array<{ token: string; data: { eventId: string } }> = [];
  // Only the external provider HTTP seam is replaced. All authenticated
  // app requests, Socket.IO events and transaction behavior remain real.
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'synthetic-access', expires_in: 3600 }), { status: 200 });
    if (url.startsWith('https://fcm.googleapis.com/')) {
      sent.push(JSON.parse(String(init?.body)).message);
      if (beforeRespond) await beforeRespond();
      return new Response(JSON.stringify({ name: 'synthetic-message' }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  try { await run(sent); }
  finally {
    globalThis.fetch = realFetch;
    if (previous === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = previous;
  }
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
  await prisma.user.updateMany({ where: { phone: { in: ['+99360000101', '+99360000102'] } }, data: { passwordHash: await bcrypt.hash(password, 4) } });
  await prisma.transaction.deleteMany();
  await prisma.order.deleteMany();
  await prisma.notificationDelivery.deleteMany();
  await prisma.notificationInstallation.deleteMany();
  await prisma.balance.updateMany({ data: { amount: 500 } });
  await prisma.$executeRaw`UPDATE native_shift_leases SET revoked_at = NOW()`;
  await prisma.driver.updateMany({ data: { isAvailable: true, isOnline: false, shiftDeviceId: null, currentDeviceId: null } });
  await prisma.driver.updateMany({ where: { user: { phone: '+99360000102' } }, data: { districtId: otherRegionId } });
  driverToken = await login('+99360000101');
  otherToken = await login('+99360000102');
  await prisma.driver.updateMany({ where: { user: { phone: { in: ['+99360000101', '+99360000102'] } } }, data: { currentDeviceId: null } });
  for (const [token, lng] of [[driverToken, 58.32], [otherToken, 58.42]] as const) {
    assert.equal((await startShift(token, lng)).status, 200);
  }
});
after(async () => {
  clients.forEach(client => client.disconnect());
  await new Promise<void>(resolve => sockets.close(() => resolve()));
  await prisma.$disconnect();
  // Application and fixture clients have separate connection pools.
  await require('../dist/lib/prisma').$disconnect();
});

test('manual region selection is retired without changing shift GPS or broadcasting region updates', async () => {
  assert.equal((await request('/driver/district', '', { districtId: otherRegionId })).status, 401);
  assert.equal((await request('/driver/district', adminToken, { districtId: otherRegionId })).status, 403);
  const admin = await socket(adminToken);
  try {
    for (const online of [true, false]) {
      if (!online) assert.equal((await request('/driver/status', driverToken, { isOnline: false })).status, 200);
      const before = await request('/driver/profile', driverToken);
      assert.equal(before.data.districtId, regionId);
      assert.equal(before.data.isOnline, online);
      const updates: unknown[] = [];
      const receive = (event: unknown) => updates.push(event);
      admin.on('districts:stats', receive);
      admin.on('driver:status', receive);
      admin.on('driver:location', receive);
      const retired = await request('/driver/district', driverToken, { districtId: otherRegionId });
      assert.equal(retired.status, 410);
      assert.equal(retired.data.details.code, 'GPS_DERIVED_REGION');
      const after = await request('/driver/profile', driverToken);
      assert.equal(after.data.districtId, regionId);
      assert.equal(after.data.isOnline, online);
      assert.equal(after.data.lastLat, before.data.lastLat);
      assert.equal(after.data.lastLng, before.data.lastLng);
      assert.equal(after.data.lastLocationAt, before.data.lastLocationAt);
      await new Promise(resolve => setTimeout(resolve, 80));
      assert.deepEqual(updates, []);
      admin.off('districts:stats', receive);
      admin.off('driver:status', receive);
      admin.off('driver:location', receive);
    }
    assert.equal((await startShift(driverToken, 58.42)).status, 200);
    const actualRegion = await request('/driver/profile', driverToken);
    assert.equal(actualRegion.data.districtId, otherRegionId);
    assert.equal(actualRegion.data.isOnline, true);
    assert.equal(Number(actualRegion.data.lastLat), 37.96);
    assert.equal(Number(actualRegion.data.lastLng), 58.42);
  } finally { admin.disconnect(); }
});

test('notification registration belongs to the approved signed-in installation and does not require a shift or GPS', async () => {
  assert.equal((await request('/driver/status', driverToken, { isOnline: false })).status, 200);
  await prisma.driver.updateMany({ where: { user: { phone: '+99360000101' } }, data: { lastLat: null, lastLng: null, lastLocationAt: null } });
  assert.equal((await request('/driver/notifications/settings')).status, 401);
  assert.equal((await request('/driver/notifications/settings', adminToken)).status, 403);
  const settings = await request('/driver/notifications/settings', driverToken);
  assert.equal(settings.status, 200);
  assert.equal(settings.data.enabled, true);
  assert.equal(settings.data.registered, false);
  assert.equal(settings.data.transportConfigured, false);
  const registered = await request('/driver/notifications/registration', driverToken, { token: 'synthetic-fcm-driver-one', enabled: true });
  assert.equal(registered.status, 200);
  assert.equal(registered.data.installationId, settings.data.installationId);
  assert.equal(typeof registered.data.notificationToken, 'string');
  const foreign = await request('/native-notifications/event', registered.data.notificationToken, { eventId: 'chat:nonexistent' });
  assert.equal(foreign.status, 200);
  assert.equal(foreign.data.event, null);
  assert.equal((await request('/driver/notifications/settings', driverToken, { enabled: false })).status, 200);
  assert.equal((await request('/driver/notifications/settings', driverToken)).data.enabled, true);
});

test('dispatcher chat creates one preview event per signed-in device without shift or GPS', async () => {
  const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
  await prisma.driver.update({ where: { id: driver.id }, data: { isOnline: false, shiftDeviceId: null, lastLat: null, lastLng: null, lastLocationAt: null } });
  const secondLogin = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-second-device' });
  assert.equal(secondLogin.status, 200);
  const firstRegistration = await request('/driver/notifications/registration', driverToken, { token: null, enabled: true });
  const secondRegistration = await request('/driver/notifications/registration', secondLogin.data.accessToken, { token: null, enabled: true });
  assert.equal(firstRegistration.status, 200);
  assert.equal(secondRegistration.status, 200);
  const firstSocket = await socket(driverToken);
  const secondSocket = await socket(secondLogin.data.accessToken);
  // Socket.IO resolves `connect` before the async driver room join finishes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const firstEvent = nextSocketEvent<any>(firstSocket, 'notification:event');
  const secondEvent = nextSocketEvent<any>(secondSocket, 'notification:event');
  const sent = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Synthetic preview' });
  assert.equal(sent.status, 200);
  const [one, two] = await Promise.all([firstEvent, secondEvent]);
  assert.equal(one.event.channel, 'chat');
  assert.equal(one.event.body, 'Synthetic preview');
  assert.equal(two.event.id, one.event.id);
  assert.equal((await prisma.notificationDelivery.count({ where: { eventId: one.event.id } })), 2);
  assert.equal((await request('/driver/notifications/ack', driverToken, { eventId: one.event.id })).status, 204);
  assert.equal((await request('/native-notifications/event', firstRegistration.data.notificationToken, { eventId: one.event.id })).status, 200);
});

test('notification fallback sends data-only FCM after grace while a foreground acknowledgement suppresses its duplicate', async () => {
  await withFakeFcm(async sent => {
    const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
    await prisma.driver.update({ where: { id: driver.id }, data: { isOnline: false, shiftDeviceId: null, lastLocationAt: null } });
    const registration = await request('/driver/notifications/registration', driverToken, { token: 'synthetic-notification-token', enabled: true });
    assert.equal(registration.status, 200);
    assert.equal(registration.data.coordinatorEnabled, true);
    const clientMessageId = randomUUID();
    const background = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Private preview stays on our server', clientMessageId });
    const replay = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Private preview stays on our server', clientMessageId });
    assert.equal(background.data.id, replay.data.id);
    assert.equal(await prisma.notificationDelivery.count({ where: { eventId: `chat:${background.data.id}` } }), 1);
    const foreground = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Visible foreground preview' });
    assert.equal((await request('/driver/notifications/ack', driverToken, { eventId: `chat:${foreground.data.id}` })).status, 204);
    await new Promise(resolve => setTimeout(resolve, 4200));
    assert.deepEqual(sent.map(row => row.data), [{ eventId: `chat:${background.data.id}` }]);
    assert.equal(sent[0].token, 'synthetic-notification-token');
    assert.equal((sent[0] as any).notification, undefined);
    const canonical = await request('/native-notifications/event', registration.data.notificationToken, { eventId: `chat:${background.data.id}` });
    assert.equal(canonical.data.event.body, 'Private preview stays on our server');
  });
});

test('an accepted FCM transport retries the same unread event until native acknowledgement', async () => {
  await withFakeFcm(async sent => {
    const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
    await prisma.driver.update({ where: { id: driver.id }, data: { isOnline: false, shiftDeviceId: null, lastLocationAt: null } });
    const registration = await request('/driver/notifications/registration', driverToken, { token: 'synthetic-unacknowledged-token', enabled: true });
    const message = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Recover this closed-app alert after a temporary fetch failure' });
    const eventId = `chat:${message.data.id}`;
    await new Promise(resolve => setTimeout(resolve, 4200));
    assert.deepEqual(sent.map(row => row.data.eventId), [eventId]);
    // Simulate the persisted retry deadline elapsing after FCM accepted the
    // wake-up but the closed app failed to fetch/acknowledge the message.
    await prisma.notificationDelivery.updateMany({ where: { eventId }, data: { notBefore: new Date(Date.now() - 1000) } });
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(sent.map(row => row.data.eventId), [eventId, eventId]);
    const canonical = await request('/native-notifications/event', registration.data.notificationToken, { eventId });
    assert.equal(canonical.data.event.body, 'Recover this closed-app alert after a temporary fetch failure');
    assert.equal((await request('/native-notifications/ack', registration.data.notificationToken, { eventId })).status, 204);
    await prisma.notificationDelivery.updateMany({ where: { eventId }, data: { notBefore: new Date(Date.now() - 1000) } });
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(sent.map(row => row.data.eventId), [eventId, eventId]);
  });
});

test('chat read synchronises exact events and legacy mute requests no longer disable delivery', async () => {
  const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
  const registration = await request('/driver/notifications/registration', driverToken, { token: null, enabled: true });
  const chat = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Read on another screen' });
  const client = await socket(driverToken);
  const readSync = nextSocketEvent<any>(client, 'chat:read');
  assert.equal((await request('/driver/messages/read', driverToken, { throughMessageId: chat.data.id })).status, 204);
  const sync = await readSync;
  assert.ok(sync.eventIds.includes(`chat:${chat.data.id}`));
  assert.equal((await request('/native-notifications/event', registration.data.notificationToken, { eventId: `chat:${chat.data.id}` })).data.event, null);
  assert.equal((await request('/driver/notifications/settings', driverToken, { enabled: false })).status, 200);
  const muted = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Legacy mute does not suppress notification' });
  assert.equal(await prisma.notificationDelivery.count({ where: { eventId: `chat:${muted.data.id}` } }), 1);
  assert.equal((await request('/driver/status', driverToken, { isOnline: false })).status, 200);
  assert.equal((await request('/driver/location', driverToken, { lat: 37.96, lng: 58.32 })).status, 403);
  assert.equal((await startShift(driverToken)).status, 200);
});

test('read invalidation wakes a previously delivered push while preserving a newer unread message', async () => {
  await withFakeFcm(async sent => {
    const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
    const registration = await request('/driver/notifications/registration', driverToken, { token: 'synthetic-read-invalidation-token', enabled: true });
    const oldMessage = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Older message' });
    await new Promise(resolve => setTimeout(resolve, 4200));
    const newerMessage = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Newer message remains unread' });
    assert.equal((await request('/driver/messages/read', driverToken, { throughMessageId: oldMessage.data.id })).status, 204);
    await new Promise(resolve => setTimeout(resolve, 1500));
    const oldEvent = `chat:${oldMessage.data.id}`;
    assert.deepEqual(sent.map(row => row.data.eventId), [oldEvent, oldEvent]);
    assert.equal((await request('/native-notifications/event', registration.data.notificationToken, { eventId: oldEvent })).data.event, null);
    const newer = await request('/native-notifications/event', registration.data.notificationToken, { eventId: `chat:${newerMessage.data.id}` });
    assert.equal(newer.data.event.body, 'Newer message remains unread');
  });
});

test('a competing claim invalidates a delivered order push with the same opaque event id', async () => {
  await withFakeFcm(async sent => {
    const registration = await request('/driver/notifications/registration', driverToken, { token: 'synthetic-order-invalidation-token', enabled: true });
    const created = await order();
    const eventId = created.notificationEventId;
    assert.equal((await request('/native-notifications/event', registration.data.notificationToken, { eventId })).data.event.orderId, created.id);
    await new Promise(resolve => setTimeout(resolve, 4200));
    assert.equal((await request('/orders/accept', otherToken, { orderId: created.id })).status, 200);
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.deepEqual(sent.map(row => row.data.eventId), [eventId, eventId]);
    assert.equal((await request('/native-notifications/event', registration.data.notificationToken, { eventId })).data.event, null);
  });
});

test('native notification capability never revives after logout and replacement login', async () => {
  const loginPair = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-approved-browser' });
  const registration = await request('/driver/notifications/registration', loginPair.data.accessToken, { token: null, enabled: true });
  assert.equal(registration.status, 200);
  assert.equal((await request('/auth/logout', '', { refreshToken: loginPair.data.refreshToken })).status, 204);
  assert.equal((await request('/native-notifications/token', registration.data.notificationToken, { token: 'stale-token-after-logout' })).status, 401);
  const replacement = await login('+99360000101');
  assert.equal((await request('/native-notifications/event', registration.data.notificationToken, { eventId: 'chat:old-event' })).status, 401);
  const renewed = await request('/driver/notifications/registration', replacement, { token: null, enabled: true });
  assert.equal(renewed.status, 200);
  assert.notEqual(renewed.data.notificationToken, registration.data.notificationToken);
  assert.equal((await request('/native-notifications/event', registration.data.notificationToken, { eventId: 'chat:old-event' })).status, 401);
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
    assert.ok(regions.data.every((region: { activeOrders: number; publicAvailableOrders: number }) => region.activeOrders === 0 && region.publicAvailableOrders === 0));
  }
});

test('offline GPS reports cannot publish location and explicit Online uses a fresh position', async () => {
  assert.equal((await request('/driver/status', driverToken, { isOnline: false })).status, 200);
  assert.equal((await request('/driver/location', driverToken, { lat: 37.96, lng: 58.32 })).status, 403);
  const created = await order();
  assert.equal((await request('/orders/available', driverToken)).status, 403);
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 403);
  assert.equal((await startShift(driverToken)).status, 200);
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
    assert.equal((await request('/driver/location', driverToken, { lat: 37.96, lng: 58.32 })).status, 403);
    assert.equal((await request('/driver/profile', driverToken)).data.isOnline, false);
  } finally { client.disconnect(); }
});

test('stale sockets receive no offers or live queues after expiry, balance changes or reconnect', async () => {
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

test('region public availability excludes assigned, reserved and stopped orders while unfinished totals remain intact', async () => {
  const outside = await socket(otherToken);
  type Stats = Array<{ id: string; activeOrders: number; publicAvailableOrders: number }>;
  const region = (stats: Stats) => stats.find(row => row.id === regionId)!;
  try {
    const createdStats = nextSocketEvent<Stats>(outside, 'districts:stats');
    const publicOrder = await order();
    assert.equal(region(await createdStats).publicAvailableOrders, 1);
    assert.equal(region((await request('/districts', driverToken)).data).publicAvailableOrders, 1);
    const claimedStats = nextSocketEvent<Stats>(outside, 'districts:stats');
    assert.equal((await request('/orders/accept', driverToken, { orderId: publicOrder.id })).status, 200);
    const afterClaim = region(await claimedStats);
    assert.equal(afterClaim.publicAvailableOrders, 0);
    assert.equal(afterClaim.activeOrders, 1, 'dispatcher unfinished work still includes the assigned trip');
    const otherDriver = (await request('/driver/profile', otherToken)).data;
    const reservedStats = nextSocketEvent<Stats>(outside, 'districts:stats');
    const privateOffer = await request('/admin/orders', adminToken, {
      districtId: regionId, priceEstimated: 10, clientPhone: '+99360000999',
      privateOfferDriverId: otherDriver.id, broadcastAfterPrivateExpiry: false
    });
    assert.equal(privateOffer.status, 201);
    assert.equal(region(await reservedStats).publicAvailableOrders, 0, 'private reservations never appear in the common count');
    // Fixture of an expired stopped private offer. Its hidden status must not
    // be counted as public work, even though the dispatcher still resolves it.
    await prisma.order.update({ where: { id: privateOffer.data.id }, data: { privateOfferExpiresAt: new Date(Date.now() - 1) } });
    assert.deepEqual((await request(`/orders/available?districtId=${regionId}`, otherToken)).data, []);
    const stopped = region((await request('/districts', adminToken)).data);
    assert.equal(stopped.publicAvailableOrders, 0);
    assert.equal(stopped.activeOrders, 2);
    const cancelledStats = nextSocketEvent<Stats>(outside, 'districts:stats');
    assert.equal((await request(`/admin/orders/${publicOrder.id}/cancel`, adminToken, { reason: 'Synthetic resolution' })).status, 200);
    assert.equal(region(await cancelledStats).publicAvailableOrders, 0);
    assert.equal(region((await request('/districts', adminToken)).data).activeOrders, 1);
  } finally { outside.disconnect(); }
});

test('overlapping public creation and resolution leaves every region viewer with the final available count', async () => {
  const outside = await socket(otherToken);
  type Stats = Array<{ id: string; activeOrders: number; publicAvailableOrders: number }>;
  const snapshots: Stats = [];
  const receive = (rows: Stats) => { snapshots.push(rows.find(row => row.id === regionId)!); };
  outside.on('districts:stats', receive);
  try {
    const created = await Promise.all(Array.from({ length: 8 }, () => order()));
    assert.equal((await request('/districts', otherToken)).data.find((row: { id: string }) => row.id === regionId).publicAvailableOrders, 8);
    const finalSnapshot = new Promise<Stats[number]>((resolve, reject) => {
      const timer = setTimeout(() => { outside.off('districts:stats', final); reject(new Error('Missing final public count')); }, 5000);
      function final(rows: Stats) {
        const row = rows.find(row => row.id === regionId)!;
        if (row.publicAvailableOrders === 0 && row.activeOrders === 1) {
          clearTimeout(timer); outside.off('districts:stats', final); resolve(row);
        }
      }
      outside.on('districts:stats', final);
    });
    const results = await Promise.all(created.map((item, index) => index === 0
      ? request('/orders/accept', driverToken, { orderId: item.id })
      : request(`/admin/orders/${item.id}/cancel`, adminToken, { reason: 'Concurrent synthetic resolution' })));
    assert.ok(results.every(result => result.status === 200));
    assert.equal((await finalSnapshot).publicAvailableOrders, 0);
    const finalHttp = (await request('/districts', otherToken)).data.find((row: { id: string }) => row.id === regionId);
    assert.equal(finalHttp.publicAvailableOrders, 0);
    assert.equal(finalHttp.activeOrders, 1);
    assert.equal(snapshots.at(-1)?.publicAvailableOrders, 0);
  } finally { outside.off('districts:stats', receive); outside.disconnect(); }
});

test('only online drivers in the selected region receive an order offer without the customer phone', async () => {
  const own = await socket(driverToken);
  const other = await socket(otherToken);
  try {
    assert.equal((await startShift(driverToken)).status, 200);
    assert.equal((await startShift(otherToken, 58.42)).status, 200);
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
  assert.equal((await startShift(otherToken)).status, 200);
  const created = await order();
  const responses = await Promise.all([driverToken, otherToken].map(token => request('/orders/accept', token, { orderId: created.id })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  const currentOrders = await Promise.all([driverToken, otherToken].map(token => request('/orders/current', token)));
  assert.equal(currentOrders.filter(response => response.data?.id === created.id).length, 1);
});

test('cancelling a claimed order releases the hold and rejects a second cancellation', async () => {
  const created = await order();
  const body = { orderId: created.id };
  assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
  assert.equal((await request('/orders/cancel', driverToken, body)).data.status, 'CANCELLED');
  assert.equal((await request('/orders/cancel', driverToken, body)).status, 409);
  const balance = await request('/driver/balance', driverToken);
  assert.equal(balance.data.amount, '500');
});

test('dispatcher cancellation releases held funds without payment or refund entries', async () => {
  const created = await order();
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 200);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  const cancelled = await request(`/admin/orders/${created.id}/cancel`, adminToken, { reason: 'Synthetic cancellation' });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'CANCELLED');
  assert.equal((await request(`/admin/orders/${created.id}/cancel`, adminToken, {})).status, 409);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  const history = await request('/driver/history', driverToken);
  assert.equal(history.status, 200);
  assert.equal(history.data.transactions.total, 0);
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
  const loggedIn = await request('/auth/login', '', { phone: body.phone, password, deviceId: 'synthetic-approved-browser' });
  assert.equal(loggedIn.status, 200);
  assert.equal(loggedIn.data.user.role, 'DRIVER');
});

test('a newly registered driver can log in only after dispatcher approval', async () => {
  const phone = '+99360000103';
  const registered = await request('/auth/register', '', { phone, password, fullName: 'Pending synthetic driver' });
  assert.equal(registered.status, 201);
  assert.equal((await request('/auth/login', '', { phone, password, deviceId: 'synthetic-approved-browser' })).status, 403);
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
  assert.equal(response.data.find((region: { id: string }) => region.id === '6fd3ea19-bcf1-41b3-8af1-df94f62b5f2f').name, 'Арчабил, Бекреве');
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

test('canonical bootstrap corrects the known old spelling without changing saved geometry', async () => {
  const { seedDefaultRegions } = require('../prisma/default-regions.cjs');
  await prisma.$transaction(async tx => seedDefaultRegions(tx));
  const id = '6fd3ea19-bcf1-41b3-8af1-df94f62b5f2f';
  await prisma.district.update({ where: { id }, data: { name: 'Ачабил, Бекреве' } });
  const before = (await request('/admin/districts', adminToken)).data.find((region: { id: string }) => region.id === id);
  await prisma.$transaction(async tx => seedDefaultRegions(tx));
  const response = await request('/admin/districts', adminToken);
  assert.deepEqual(response.data.find((region: { id: string }) => region.id === id), { ...before, name: 'Арчабил, Бекреве' });
  assert.deepEqual(await prisma.$transaction(async tx => seedDefaultRegions(tx)), { created: 0, filled: 0, preserved: 9 });
});

test('region spelling migration changes only the known old canonical name and preserves edited geometry', async () => {
  const { seedDefaultRegions } = require('../prisma/default-regions.cjs');
  await prisma.$transaction(async tx => seedDefaultRegions(tx));
  const id = '6fd3ea19-bcf1-41b3-8af1-df94f62b5f2f';
  const edited = [[[37.91, 58.31], [37.95, 58.31], [37.95, 58.36], [37.91, 58.31]]];
  await prisma.district.update({ where: { id }, data: { name: 'Ачабил, Бекреве', boundary: edited, baseFare: 19 } });
  const unrelated = await prisma.district.create({ data: { name: 'Ачабил, Бекреве', centerLat: 37.97, centerLng: 58.39 } });
  const before = (await request('/admin/districts', adminToken)).data.find((region: { id: string }) => region.id === id);
  const migration = readFileSync(join(__dirname, '../prisma/migrations/20261017140000_archabil_region_spelling/migration.sql'), 'utf8');
  try {
    await prisma.$executeRawUnsafe(migration);
    const response = await request('/admin/districts', adminToken);
    assert.deepEqual(response.data.find((region: { id: string }) => region.id === id), { ...before, name: 'Арчабил, Бекреве' });
    assert.equal(response.data.find((region: { id: string }) => region.id === unrelated.id).name, 'Ачабил, Бекреве');

    // Reapplying is harmless, and a separately edited canonical name wins.
    assert.equal(await prisma.$executeRawUnsafe(migration), 0);
    await prisma.district.update({ where: { id }, data: { name: 'Custom dispatcher region name' } });
    assert.equal(await prisma.$executeRawUnsafe(migration), 0);
    const preserved = await request('/admin/districts', adminToken);
    assert.deepEqual(preserved.data.find((region: { id: string }) => region.id === id), { ...before, name: 'Custom dispatcher region name' });
  } finally {
    await prisma.district.delete({ where: { id: unrelated.id } });
    await prisma.district.update({ where: { id }, data: { name: 'Арчабил, Бекреве' } });
  }
});

test('native inbox safely replays notifications and removes consumed orders and chats', async () => {
  const island = await prisma.district.create({ data: { name: 'Native synthetic island', centerLat: 0, centerLng: 0, boundary: [[[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01]]] } });
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-approved-browser' });
  await request('/driver/location', auth.data.accessToken, { lat: 0, lng: 0 });
  await request('/driver/status', auth.data.accessToken, { isOnline: true });
  assert.equal(auth.status, 200);
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'synthetic-approved-browser', refreshToken: auth.data.refreshToken });
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

test('native public alerts stay in the original region for 20 seconds while queues remain global', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000102', password, deviceId: 'synthetic-approved-browser' });
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'synthetic-approved-browser', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  const outside = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99360000999' });
  const own = await request('/admin/orders', adminToken, { districtId: otherRegionId, priceEstimated: 10, clientPhone: '+99360000999' });
  const tick = () => request('/native-shift/tick', started.data.shiftToken, { lat: 37.96, lng: 58.42, recordedAt: new Date().toISOString() });
  const first = await tick();
  assert.deepEqual(first.data.events.filter((event: { channel: string }) => event.channel === 'orders').map((event: { orderId: string }) => event.orderId), [own.data.id]);
  const ownEvent = first.data.events.find((event: { orderId: string }) => event.orderId === own.data.id);
  assert.equal(ownEvent.expiresAt, own.data.publicRegionOnlyUntil);
  assert.equal((await request(`/orders/available?districtId=${regionId}`, auth.data.accessToken)).data[0].id, outside.data.id);
  await prisma.order.update({ where: { id: own.data.id }, data: { publicRegionOnlyUntil: new Date(Date.now() - 1) } });
  assert.deepEqual((await tick()).data.events, []);
  assert.equal((await request(`/orders/available?districtId=${otherRegionId}`, auth.data.accessToken)).data[0].id, own.data.id);
  const selected = (await request('/driver/profile', auth.data.accessToken)).data;
  const privateOrder = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99360000999', privateOfferDriverId: selected.id });
  assert.equal((await tick()).data.events[0].orderId, privateOrder.data.id);
  await prisma.order.update({ where: { id: privateOrder.data.id }, data: { privateOfferExpiresAt: new Date(Date.now() - 1) } });
  assert.deepEqual((await tick()).data.events, [], 'private fallback is public availability without a second alert');
});

test('native chat inbox includes the newest unread message when more than one hundred are pending', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-approved-browser' });
  await request('/driver/location', auth.data.accessToken, { lat: 37.96, lng: 58.32 });
  await request('/driver/status', auth.data.accessToken, { isOnline: true });
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'synthetic-approved-browser', refreshToken: auth.data.refreshToken });
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
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-approved-browser' });
  const body = { deviceId: 'synthetic-approved-browser', refreshToken: auth.data.refreshToken };
  assert.equal((await request('/driver/shift', auth.data.accessToken, { ...body, deviceId: 'wrong-device' })).status, 403);
  await request('/driver/status', auth.data.accessToken, { isOnline: false });
  assert.equal((await request('/driver/shift', auth.data.accessToken, body)).status, 403);
  await startShift(auth.data.accessToken);
  const first = await request('/driver/shift', auth.data.accessToken, body);
  assert.equal(first.status, 201);
  const fix = { lat: 0, lng: 0, recordedAt: new Date().toISOString() };
  assert.equal((await request('/native-shift/tick', first.data.shiftToken, { ...fix, recordedAt: new Date(Date.now() - 31000).toISOString() })).status, 400);
  assert.equal((await request('/native-shift/tick', 'invalid-token', fix)).status, 401);
  await prisma.$executeRaw`UPDATE native_shift_leases SET expires_at = NOW() - INTERVAL '1 second'`;
  assert.equal((await request('/native-shift/tick', first.data.shiftToken, fix)).status, 401);
  assert.equal((await request('/driver/profile', auth.data.accessToken)).data.isOnline, false);
  assert.equal((await startShift(auth.data.accessToken)).status, 200);
  const second = await request('/driver/shift', auth.data.accessToken, body);
  assert.equal(second.status, 201);
  await request('/native-shift/stop', first.data.shiftToken, {});
  assert.equal((await request('/native-shift/tick', second.data.shiftToken, fix)).status, 200);
  await request('/auth/logout', '', { refreshToken: auth.data.refreshToken });
  assert.equal((await request('/native-shift/tick', second.data.shiftToken, fix)).status, 401);
  assert.equal((await request('/driver/profile', auth.data.accessToken)).status, 401);
  const renewed = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-approved-browser' });
  assert.equal((await request('/driver/profile', renewed.data.accessToken)).data.isOnline, false);
});

test('native task stop publishes persisted offline state to the driver and dispatcher', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-approved-browser' });
  await request('/driver/location', auth.data.accessToken, { lat: 37.96, lng: 58.32 });
  await request('/driver/status', auth.data.accessToken, { isOnline: true });
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'synthetic-approved-browser', refreshToken: auth.data.refreshToken });
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
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-approved-browser' });
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'synthetic-approved-browser', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  assert.equal((await request('/driver/shift/stop', auth.data.accessToken, {})).status, 204);
  const fix = { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() };
  assert.equal((await request('/native-shift/tick', started.data.shiftToken, fix)).status, 401);
  assert.equal((await request('/driver/profile', auth.data.accessToken)).data.isOnline, false);
  assert.equal((await startShift(auth.data.accessToken)).status, 200);
  assert.equal((await request('/native-shift/stop', started.data.shiftToken, {})).status, 204);
  assert.equal((await request('/driver/profile', auth.data.accessToken)).data.isOnline, true);
});
for (const scenario of ['driver-driver', 'admin-admin', 'driver-admin']) {
  test(`cancellation stress: ${scenario} releases exactly once across 20 races`, async () => {
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
      if (after !== before || refunds !== 0 || responses.filter(r => r.status === 200).length !== 1) failures.push({round, statuses: responses.map(r => r.status), before, after, refunds});
    }
    assert.equal(failures.length, 0, 'concurrent cancellation must release once without a ledger refund and have one winner');
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
    const responses = await Promise.all([request('/orders/start', driverToken, body), request(`/admin/orders/${created.id}/cancel`, adminToken, {})]);
    const current = (await request('/orders/current', driverToken)).data;
    const balance = Number((await request('/driver/balance', driverToken)).data.amount);
    if (responses.filter(r=>r.status===200).length !== 1 || (current?.status === 'STARTED' && balance !== 490) || (!current && balance !== 500)) failures.push({round,statuses:responses.map(r=>r.status),current:current?.status ?? null,balance});
  }
  assert.equal(failures.length,0,'only one allowed state transition may win');
});


test('concurrent claims of different orders keep one active trip and one hold', async () => {
  for (let round = 0; round < 20; round++) {
    const first = await order();
    const second = await order();
    const responses = await Promise.all([first, second].map(created => request('/orders/accept', driverToken, { orderId: created.id })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const current = (await request('/orders/current', driverToken)).data;
    assert.ok([first.id, second.id].includes(current.id));
    assert.equal((await request('/driver/profile', driverToken)).data.isAvailable, false);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
    assert.equal((await request('/orders/cancel', driverToken, { orderId: current.id })).status, 200);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  }
});

test('cancellation wins once over repeated arrival and emits one committed release', async () => {
  const client = await socket(adminToken);
  const created = await order();
  const body = { orderId: created.id };
  assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
  assert.equal((await request('/orders/waiting', driverToken, body)).status, 200);
  const cancelled: string[] = [];
  const refunds: string[] = [];
  client.on('order:cancelled', event => { if (event.id === created.id) cancelled.push(event.id); });
  client.on('balance:updated', event => { if (event.orderId === created.id && event.reason === 'RELEASE') refunds.push(event.orderId); });
  const responses = await Promise.all([
    request('/orders/waiting', driverToken, body),
    request(`/admin/orders/${created.id}/cancel`, adminToken, {}),
    request(`/admin/orders/${created.id}/cancel`, adminToken, {})
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
      assert.equal(balance, '500');
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

test('topups racing order holds and releases reconcile through public history', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  for (let round = 0; round < 20; round++) {
    const created = await order();
    const responses = await Promise.all([
      request('/orders/accept', driverToken, { orderId: created.id }),
      request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 1, type: 'TOPUP' })
    ]);
    assert.ok(responses.every(response => response.status === 200));
    assert.equal((await request('/driver/balance', driverToken)).data.amount, String(501 + round * 2));
    const cancelled = await Promise.all([
      request('/orders/cancel', driverToken, { orderId: created.id }),
      request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 1, type: 'TOPUP' })
    ]);
    assert.ok(cancelled.every(response => response.status === 200));
    assert.equal((await request('/driver/balance', driverToken)).data.amount, String(502 + round * 2));
  }
  const history = (await request('/driver/history?limit=100', driverToken)).data.transactions;
  assert.equal(history.total, 40);
  assert.equal(history.items.filter((entry: { type: string }) => entry.type === 'PAYMENT').length, 0);
  assert.equal(history.items.filter((entry: { type: string }) => entry.type === 'REFUND').length, 0);
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

test('a failed ledger insert rolls back the start and wallet before a safe retry', async () => {
  const created = await order();
  const client = await socket(adminToken);
  const payments: unknown[] = [];
  client.on('balance:updated', event => { if (event.orderId === created.id && event.reason === 'PAYMENT') payments.push(event); });
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 200);
  assert.equal((await request('/orders/waiting', driverToken, { orderId: created.id })).status, 200);
  // A storage-boundary failure fixture, confined to this disposable schema.
  await prisma.$executeRawUnsafe('ALTER TABLE transactions ADD CONSTRAINT fail_test_payment CHECK (amount <> -10)');
  try {
    assert.equal((await request('/orders/start', driverToken, { orderId: created.id })).status, 500);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
    assert.equal((await request('/orders/current', driverToken)).data.status, 'WAITING');
    assert.equal((await request('/driver/profile', driverToken)).data.isAvailable, false);
    assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 0);
    assert.equal(payments.length, 0);
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE transactions DROP CONSTRAINT fail_test_payment');
  }
  assert.equal((await request('/orders/start', driverToken, { orderId: created.id })).status, 200);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '490');
  const history = (await request('/driver/history', driverToken)).data.transactions;
  assert.equal(history.total, 1);
  assert.equal(history.items[0].amount, '-10');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(payments.length, 1);
  client.disconnect();
});

test('private offers reserve cross-region orders and acceptance holds without charging', async () => {
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
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '500');
});

test('a declined private offer stays exclusive until expiry and an old response cannot decline a newer reservation', async () => {
  const driver = (await request('/driver/profile', otherToken)).data;
  const created = await order();
  const offered = await request(`/admin/orders/${created.id}/private-offer`, adminToken, { driverId: driver.id });
  assert.equal(offered.status, 200);
  const deadline = offered.data.privateOfferExpiresAt;
  assert.equal((await request('/orders/private-offer/decline', driverToken, { orderId: created.id, privateOfferExpiresAt: deadline })).status, 409);
  assert.equal((await request('/orders/private-offer/decline', otherToken, { orderId: created.id, privateOfferExpiresAt: deadline })).status, 200);
  assert.equal((await request(`/orders/available?districtId=${regionId}`, driverToken)).data.length, 0);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '500');
  await prisma.order.update({ where: { id: created.id }, data: { privateOfferExpiresAt: new Date(Date.now() - 1) } });
  assert.equal((await request(`/orders/available?districtId=${regionId}`, driverToken)).data[0].id, created.id);
  const renewed = await request(`/admin/orders/${created.id}/private-offer`, adminToken, { driverId: driver.id });
  assert.equal(renewed.status, 200);
  assert.notEqual(renewed.data.privateOfferExpiresAt, deadline);
  assert.equal((await request('/orders/private-offer/decline', otherToken, { orderId: created.id, privateOfferExpiresAt: deadline })).status, 409);
  assert.equal((await request('/orders/private-offer', otherToken)).data.privateOfferExpiresAt, renewed.data.privateOfferExpiresAt);
});

for (const fallback of [true, false]) {
  test(`declining a private offer keeps its fixed exclusive deadline before applying fallback=${fallback}`, async () => {
    const selected = (await request('/driver/profile', otherToken)).data;
    const originalRegion = await socket(driverToken);
    const publicPopups: unknown[] = [];
    originalRegion.on('order:new', event => publicPopups.push(event));
    const created = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: selected.id, broadcastAfterPrivateExpiry: fallback });
    assert.equal(created.status, 201);
    assert.equal((await request('/orders/private-offer/decline', otherToken, { orderId: created.data.id, privateOfferExpiresAt: created.data.privateOfferExpiresAt })).status, 200);
    assert.equal((await request('/orders/private-offer', otherToken)).data, null);
    assert.equal((await request(`/orders/available?districtId=${regionId}`, driverToken)).data.length, 0);
    assert.equal((await request('/orders/accept', driverToken, { orderId: created.data.id })).status, 409);
    assert.equal((await request('/orders/private-offer/accept', otherToken, { orderId: created.data.id, privateOfferExpiresAt: created.data.privateOfferExpiresAt })).status, 409);
    await prisma.order.update({ where: { id: created.data.id }, data: { privateOfferExpiresAt: new Date(Date.now() - 1) } });
    const released = (await request(`/orders/available?districtId=${regionId}`, otherToken)).data;
    assert.equal(released.some((item: { id: string }) => item.id === created.data.id), fallback);
    const result = await request('/orders/accept', driverToken, { orderId: created.data.id });
    assert.equal(result.status, fallback ? 200 : 409);
    assert.deepEqual(publicPopups, []);
    originalRegion.disconnect();
  });
}

test('declining frees the driver to claim other work while the declined order stays exclusive until its deadline', async () => {
  const selected = (await request('/driver/profile', otherToken)).data;
  const reserved = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: selected.id });
  assert.equal((await request('/orders/private-offer/decline', otherToken, { orderId: reserved.data.id, privateOfferExpiresAt: reserved.data.privateOfferExpiresAt })).status, 200);
  const another = await order();
  assert.equal((await request('/orders/accept', otherToken, { orderId: another.id })).status, 200);
  assert.equal((await request(`/orders/available?districtId=${regionId}`, driverToken)).data.some((item: { id: string }) => item.id === reserved.data.id), false);
  assert.equal((await request('/orders/accept', driverToken, { orderId: reserved.data.id })).status, 409);
});

test('private offer deadline survives recovery and expires to the global queue without a debit', async () => {
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

test('private expiry expansion is simultaneous across regions and any driver can claim once', async () => {
  const selected = (await request('/driver/profile', driverToken)).data;
  const regionalDriver = await socket(driverToken);
  const outsideDriver = await socket(otherToken);
  const publicEvent = nextSocketEvent<{ orderId: string; districtId: string }>(outsideDriver, 'order:available');
  const unexpectedPopups: unknown[] = [];
  outsideDriver.on('order:new', event => unexpectedPopups.push(event));
  regionalDriver.on('order:new', event => unexpectedPopups.push(event));
  const created = await request('/admin/orders', adminToken, {
    districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: selected.id
  });
  assert.equal(created.status, 201);
  await prisma.order.update({ where: { id: created.data.id }, data: { privateOfferExpiresAt: new Date(Date.now() - 1) } });
  const sweep = request(`/orders/available?districtId=${regionId}`, otherToken);
  const event = await publicEvent;
  assert.equal(event.orderId, created.data.id);
  assert.deepEqual(unexpectedPopups, []);
  const available = await sweep;
  assert.equal(available.data[0].id, created.data.id);
  const accepted = await request('/orders/accept', otherToken, { orderId: created.data.id });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.driverId, (await request('/driver/profile', otherToken)).data.id);
  regionalDriver.disconnect();
  outsideDriver.disconnect();
});

test('dispatcher can stop a private offer at expiry without public fanout', async () => {
  const selected = (await request('/driver/profile', driverToken)).data;
  const outsideDriver = await socket(otherToken);
  const unexpected = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), 300);
    outsideDriver.once('order:new', () => { clearTimeout(timer); resolve(true); });
  });
  const created = await request('/admin/orders', adminToken, {
    districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: selected.id,
    broadcastAfterPrivateExpiry: false
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.broadcastAfterPrivateExpiry, false);
  await prisma.order.update({ where: { id: created.data.id }, data: { privateOfferExpiresAt: new Date(Date.now() - 1) } });
  assert.equal((await request(`/orders/available?districtId=${regionId}`, otherToken)).data.some((item: { id: string }) => item.id === created.data.id), false);
  assert.equal(await unexpected, false);
  outsideDriver.disconnect();
});

test('one driver cannot claim two different orders concurrently and a pending offer blocks public claims', async () => {
  const first = await order();
  const second = await order();
  const results = await Promise.all([first, second].map(item => request('/orders/accept', driverToken, { orderId: item.id })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
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
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '500');
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
  await startShift(session.data.accessToken, 58.32);
  await request('/driver/status', session.data.accessToken, { isOnline: true, isAvailable: true });
  const created = await order();
  assert.equal((await request('/orders/accept', session.data.accessToken, { orderId: created.id, arrivalMinutes: 5 })).status, 200);
  const disconnected = socketEvent(oldSocket, 'disconnect');
  const result = await request(`/admin/drivers/${id}/profile`, adminToken, { fullName: 'New identity', phone: '+99361001002' });
  assert.equal(result.status, 200);
  await disconnected;
  assert.equal((await request('/driver/profile', session.data.accessToken)).status, 401);
  assert.equal((await request('/auth/refresh', '', { refreshToken: session.data.refreshToken })).status, 401);
  assert.equal((await request('/auth/login', '', { phone: '+99361001003', password, deviceId: 'synthetic-approved-browser' })).status, 401);
  const recovered = await request('/auth/login', '', { phone: '+99361001002', password, deviceId: 'credential-device' });
  assert.equal(recovered.status, 200);
  const restored = await request('/driver/profile', recovered.data.accessToken);
  assert.equal(restored.data.currentDeviceId, undefined);
  assert.equal(restored.data.isOnline, false);
  assert.equal((await request('/driver/balance', recovered.data.accessToken)).data.amount, '500');
  assert.equal((await request('/orders/current', recovered.data.accessToken)).data.id, created.id);
  const rejected = connect(base, { auth: { token: session.data.accessToken }, transports: ['websocket'], reconnection: false });
  clients.push(rejected);
  const [error] = await socketEvent(rejected, 'connect_error');
  assert.equal(error.message, 'unauthorized');
});

test('dispatcher resets driver password with confirmation and revokes all prior refresh generations', async () => {
  await request('/admin/drivers', adminToken, { fullName: 'Password fixture', phone: '+99361001004', password });
  const session = await request('/auth/login', '', { phone: '+99361001004', password, deviceId: 'synthetic-approved-browser' });
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
  assert.equal((await request('/auth/login', '', { phone: '+99361001004', password, deviceId: 'synthetic-approved-browser' })).status, 401);
  assert.equal((await request('/auth/login', '', { phone: '+99361001004', password: body.password, deviceId: 'synthetic-approved-browser' })).status, 200);
});

test('a credential change keeps the driver offline when an old online request is already in flight', async () => {
  const fixture = await request('/admin/drivers', adminToken, { fullName: 'Concurrent credential fixture', phone: '+99361001005', password });
  const session = await request('/auth/login', '', { phone: '+99361001005', password, deviceId: 'synthetic-approved-browser' });
  const token = session.data.accessToken;
  await startShift(token, 58.32);
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
  const session = await request('/auth/login', '', { phone: '+99360000102', password: 'SyntheticReplacement123!', deviceId: 'synthetic-approved-browser' });
  assert.equal(session.status, 200);
  const token = session.data.accessToken;
  assert.equal((await request('/orders/private-offer', token)).status, 403);
  assert.equal((await startShift(token, 58.42)).status, 200);
  assert.equal((await request('/driver/status', token, { isOnline: true })).status, 200);
  const recovered = await request('/orders/private-offer', token);
  assert.equal(recovered.data.id, created.data.id);
  assert.equal(recovered.data.privateOfferExpiresAt, created.data.privateOfferExpiresAt);
  assert.equal(recovered.data.clientPhone, undefined);
  assert.equal((await request('/driver/balance', token)).data.amount, '500');
  assert.equal((await request('/orders/private-offer/accept', token, { orderId: recovered.data.id, privateOfferExpiresAt: recovered.data.privateOfferExpiresAt })).status, 200);
  assert.equal((await request('/driver/balance', token)).data.amount, '500');
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
  await startShift(token, 58.32);
  await request('/driver/status', token, { isOnline: true });
  const started = await request('/driver/shift', token, { deviceId: 'native-credential-device', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  const changedPassword = 'UpdatedNative123!';
  assert.equal((await request(`/admin/drivers/${id}/password`, adminToken, { password: changedPassword, passwordConfirmation: changedPassword })).status, 200);
  const fresh = await request('/auth/login', '', { phone, password: changedPassword, deviceId: 'native-credential-device' });
  assert.equal(fresh.status, 200);
  await startShift(fresh.data.accessToken, 58.32);
  await request('/driver/status', fresh.data.accessToken, { isOnline: true });
  assert.equal((await request('/native-shift/tick', started.data.shiftToken, { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() })).status, 401);
});

test('native private offer replay preserves the persisted deadline and acceptance removes its notification', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-approved-browser' });
  assert.equal(auth.status, 200);
  const token = auth.data.accessToken;
  const started = await request('/driver/shift', token, { deviceId: 'synthetic-approved-browser', refreshToken: auth.data.refreshToken });
  assert.equal(started.status, 201);
  const profile = (await request('/driver/profile', token)).data;
  const offered = await request('/admin/orders', adminToken, { districtId: otherRegionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: profile.id });
  assert.equal(offered.status, 201);
  const fix = () => ({ lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() });
  const first = await request('/native-shift/tick', started.data.shiftToken, fix());
  const event = first.data.events.find((item: { orderId?: string }) => item.orderId === offered.data.id);
  assert.equal(event.expiresAt, offered.data.privateOfferExpiresAt);
  assert.equal(event.id, offered.data.notificationEventId);
  assert.equal(JSON.stringify(first.data.events).includes('+99365000000'), false);
  const replay = await request('/native-shift/tick', started.data.shiftToken, fix());
  const replayEvent = replay.data.events.find((item: { orderId?: string }) => item.orderId === offered.data.id);
  assert.equal(replayEvent.id, event.id);
  assert.equal(replayEvent.expiresAt, event.expiresAt);
  assert.equal(replayEvent.offerAttemptId, event.offerAttemptId);
  assert.ok(replayEvent.serverTime);
  const recovered = await request('/orders/private-offer', token);
  assert.equal(recovered.data.privateOfferExpiresAt, event.expiresAt);
  assert.equal((await request('/orders/private-offer/accept', token, { orderId: offered.data.id, privateOfferExpiresAt: event.expiresAt })).status, 200);
  const accepted = await request('/native-shift/tick', started.data.shiftToken, fix());
  assert.equal(accepted.data.events.some((item: { orderId?: string }) => item.orderId === offered.data.id), false);
  assert.equal((await request('/driver/balance', token)).data.amount, '500');
});
test('private confirmation and cancellation preserve credits with one hold release and no debit', async () => {
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
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '501');
  const cancelled = await Promise.all([
    request('/orders/cancel', otherToken, { orderId: created.data.id }),
    request(`/admin/orders/${created.data.id}/cancel`, adminToken, {}),
    request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 1, type: 'TOPUP' })
  ]);
  assert.deepEqual(cancelled.map(response => response.status).sort(), [200, 200, 409]);
  assert.equal((await request('/driver/balance', otherToken)).data.amount, '502');
  const history = (await request('/driver/history', otherToken)).data.transactions;
  assert.equal(history.total, 2);
  assert.equal(history.items.filter((entry: { type: string }) => entry.type === 'PAYMENT').length, 0);
  assert.equal(history.items.filter((entry: { type: string }) => entry.type === 'REFUND').length, 0);
  assert.equal(history.items.reduce((sum: number, entry: { amount: string }) => sum + Number(entry.amount), 0), 2);
});

test('a native renewal blocked beyond lease expiry cannot restore availability', async () => {
  const auth = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-approved-browser' });
  assert.equal(auth.status, 200);
  const started = await request('/driver/shift', auth.data.accessToken, { deviceId: 'synthetic-approved-browser', refreshToken: auth.data.refreshToken });
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
  await startShift(token, 58.32);
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
  assert.equal((await request('/auth/login', '', { phone, password: '123456', deviceId: 'synthetic-approved-browser' })).status, 401);
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
  assert.equal((await request('/auth/login', '', { phone: '+99361001092', password: '123456', deviceId: 'synthetic-approved-browser' })).status, 200);
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
  assert.equal((await request('/auth/login', '', { phone: formatted, password: '123456', deviceId: 'synthetic-approved-browser' })).status, 200);
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
    assert.equal((await request(`/admin/drivers/${user.driver!.id}/block`, adminToken, { reason: 'Synthetic account safety block' })).status, 200);
    const unblocked = nextSocketEvent(client, 'districts:stats', 500);
    assert.equal((await request(`/admin/drivers/${user.driver!.id}/unblock`, adminToken, {})).status, 200);
    await unblocked;
    const removed = nextSocketEvent(client, 'districts:stats', 500);
    const response = await fetch(`${base}/admin/drivers/${user.driver!.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(response.status, 204);
    await removed;
    assert.equal((await request('/admin/overview', adminToken)).data.totalDrivers, 3);
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
    const online = await startShift(driverToken);
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
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '30');
  assert.equal((await request('/driver/status', driverToken, { isOnline: false })).status, 200);
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
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '35');
  assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 0);
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

test('driver completion racing dispatcher resolution has one terminal winner without deadlock or another charge', async () => {
  const created = await order();
  const body = { orderId: created.id };
  for (const action of ['accept', 'waiting', 'start']) assert.equal((await request(`/orders/${action}`, driverToken, body)).status, 200);
  const driver = (await request('/driver/profile', driverToken)).data;
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const heldDriver = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driver.id} FOR UPDATE`;
    acquired();
    await gate;
  }, { timeout: 10000 });
  async function waitForBlockedDrivers(count: number) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const waiting = await prisma.$queryRaw<Array<{ pid: number }>>`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%drivers%'`;
      if (waiting.length >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Completion/resolution did not reach the held driver lock');
  }
  let completed: ReturnType<typeof request> | undefined;
  let resolved: ReturnType<typeof request> | undefined;
  try {
    await ready;
    completed = request('/orders/complete', driverToken, body);
    await waitForBlockedDrivers(1);
    resolved = request(`/admin/orders/${created.id}/force-resolve`, adminToken, { reason: 'Concurrent dispatcher confirmation' });
    await waitForBlockedDrivers(2);
  } finally {
    release();
    await heldDriver;
  }
  const results = await Promise.all([completed!, resolved!]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await request('/orders/current', driverToken)).data, null);
  assert.equal((await request('/driver/profile', driverToken)).data.isAvailable, true);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '490');
  const history = (await request('/driver/history', driverToken)).data;
  assert.equal(history.orders.items.find((item: { id: string }) => item.id === created.id).status, 'COMPLETED');
  assert.equal(history.transactions.total, 1);
  assert.equal(history.transactions.items[0].amount, '-10');
});



test('browser location timestamps reject stale and future fixes without replacing saved GPS', async () => {
  const original = (await request('/driver/profile', driverToken)).data;
  for (const capturedAt of [Date.now() - 61000, Date.now() + 10000]) {
    assert.equal((await request('/driver/location', driverToken, { lat: 30, lng: 120, capturedAt })).status, 400);
  }
  const unchanged = (await request('/driver/profile', driverToken)).data;
  assert.equal(unchanged.lastLocationAt, original.lastLocationAt);
  assert.equal(unchanged.lastLat, original.lastLat);
  assert.equal((await request('/driver/location', driverToken, { lat: 37.96, lng: 58.32, capturedAt: Date.now() })).status, 200);
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

test('GPS capture time stays identical in profile, location event and history', async () => {
  const admin = await socket(adminToken);
  const capturedAt = Date.now() - 50000;
  const event = nextSocketEvent<{ recordedAt: string }>(admin, 'driver:location');
  const report = await request('/driver/location', driverToken, { lat: 37.96, lng: 58.32, accuracy: 10, capturedAt });
  assert.equal(report.status, 200);
  const expected = new Date(capturedAt).toISOString();
  assert.equal(report.data.recordedAt, expected);
  assert.equal((await event).recordedAt, expected);
  const profile = (await request('/driver/profile', driverToken)).data;
  assert.equal(profile.lastLocationAt, expected);
  const history = await prisma.driverLocation.findFirstOrThrow({ where: { driverId: profile.id, recordedAt: new Date(capturedAt) } });
  assert.equal(history.recordedAt.toISOString(), expected);
});

test('public orders reach all regions immediately while only the original region gets a popup and the first claim closes every queue', async () => {
  const regional = await socket(driverToken);
  const outside = await socket(otherToken);
  const outsidePopups: unknown[] = [];
  outside.on('order:new', event => outsidePopups.push(event));
  const regionalPopup = nextSocketEvent<{ id: string; clientPhone?: string }>(regional, 'order:new');
  const globalUpdate = nextSocketEvent<{ orderId: string; districtId: string }>(outside, 'order:available');
  const created = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000' });
  assert.equal(created.status, 201);
  const available = await request(`/orders/available?districtId=${regionId}`, otherToken);
  assert.equal(available.data[0]?.id, created.data.id, 'another region sees a newly created public order before 20 seconds');
  assert.equal(available.data[0].clientPhone, undefined);
  const popup = await regionalPopup;
  assert.equal(popup.id, created.data.id);
  assert.equal(popup.clientPhone, undefined);
  const update = await globalUpdate as any;
  assert.equal(update.orderId, created.data.id);
  assert.equal(update.districtId, regionId);
  assert.equal(update.notificationEventId, created.data.notificationEventId);
  assert.equal(update.offerAttemptId, created.data.offerAttemptId);
  const removedRegional = nextSocketEvent<{ orderId: string }>(regional, 'order:taken');
  const removedOutside = nextSocketEvent<{ orderId: string }>(outside, 'order:taken');
  const claims = await Promise.all([driverToken, otherToken].map(token => request('/orders/accept', token, { orderId: created.data.id })));
  assert.deepEqual(claims.map(result => result.status).sort(), [200, 409]);
  assert.equal((await removedRegional).orderId, created.data.id);
  assert.equal((await removedOutside).orderId, created.data.id);
  assert.equal((await request(`/orders/available?districtId=${regionId}`, driverToken)).data.length, 0);
  assert.equal((await request(`/orders/available?districtId=${regionId}`, otherToken)).data.length, 0);
  assert.deepEqual(outsidePopups, []);
  regional.disconnect(); outside.disconnect();
});

for (const deadlineOffset of [-1, 20_000]) {
test(`existing public rows remain globally claimable with a regional deadline offset=${deadlineOffset} and stale private fallback disabled`, async () => {
  const created = await order();
  // Fixture: a public order persisted by the previous regional-first release.
  await prisma.order.update({ where: { id: created.id }, data: { publicReleasedGloballyAt: null, publicRegionOnlyUntil: new Date(Date.now() + deadlineOffset), broadcastAfterPrivateExpiry: false } });
  const available = await request(`/orders/available?districtId=${regionId}`, otherToken);
  assert.equal(available.data[0].id, created.id);
  assert.equal((await request('/orders/accept', otherToken, { orderId: created.id })).status, 200);
});
}

test('dispatcher cancellation closes a fresh public order in every region without a manual refresh', async () => {
  const original = await socket(driverToken);
  const outside = await socket(otherToken);
  const originalStats = nextSocketEvent<Array<{ id: string; activeOrders: number }>>(original, 'districts:stats');
  const outsideStats = nextSocketEvent<Array<{ id: string; activeOrders: number }>>(outside, 'districts:stats');
  const created = await order();
  for (const stats of await Promise.all([originalStats, outsideStats])) assert.equal(stats.find(row => row.id === regionId)?.activeOrders, 1);
  const removedOriginal = nextSocketEvent<{ orderId: string }>(original, 'order:taken');
  const removedOutside = nextSocketEvent<{ orderId: string }>(outside, 'order:taken');
  const updatedStats = nextSocketEvent<Array<{ id: string; activeOrders: number }>>(outside, 'districts:stats');
  assert.equal((await request(`/admin/orders/${created.id}/cancel`, adminToken, { reason: 'Customer cancelled' })).status, 200);
  assert.equal((await removedOriginal).orderId, created.id);
  assert.equal((await removedOutside).orderId, created.id);
  assert.equal((await updatedStats).find(row => row.id === regionId)?.activeOrders, 0);
  assert.equal((await request(`/orders/available?districtId=${regionId}`, otherToken)).data.length, 0);
  assert.equal((await request('/orders/accept', otherToken, { orderId: created.id })).status, 409);
  original.disconnect(); outside.disconnect();
});

test('dispatcher lifecycle filters separate unclaimed waiting from in-progress orders and preserve legacy active queries', async () => {
  const statuses = ['NEW', 'ACCEPTED', 'WAITING', 'STARTED', 'COMPLETED', 'CANCELLED'] as const;
  const ids = new Map<string, string>();
  for (const status of statuses) {
    const created = await prisma.order.create({ data: { districtId: regionId, status, pickupLat: 37.96, pickupLng: 58.32, clientPhone: '+99365000000', priceEstimated: 25 } });
    ids.set(status, created.id);
  }
  const expectations = [
    ['waiting', ['NEW']],
    ['accepted', ['ACCEPTED', 'WAITING', 'STARTED']],
    ['completed', ['COMPLETED']],
    ['cancelled', ['CANCELLED']],
    ['active', ['NEW', 'ACCEPTED', 'WAITING', 'STARTED']],
    ['all', [...statuses]],
  ] as const;
  for (const [filter, wanted] of expectations) {
    const response = await request(`/admin/orders?status=${filter}`, adminToken);
    assert.equal(response.status, 200);
    assert.equal(response.data.total, wanted.length);
    assert.deepEqual(response.data.items.map((item: { id: string }) => item.id).sort(), wanted.map(status => ids.get(status)).sort());
  }
  assert.equal((await request('/admin/orders', adminToken)).data.total, 6);
  assert.equal((await request('/admin/orders?status=unknown', adminToken)).status, 400);
});

for (const status of ['ACCEPTED', 'WAITING', 'STARTED'] as const) {
  test(`active ${status} trip stays busy across Online and legacy availability snapshots`, async () => {
    const driver = (await request('/driver/profile', driverToken)).data;
    const active = await order(25);
    assert.equal((await request('/orders/accept', driverToken, { orderId: active.id, arrivalMinutes: 5 })).status, 200);
    if (status !== 'ACCEPTED') assert.equal((await request('/orders/waiting', driverToken, { orderId: active.id })).status, 200);
    if (status === 'STARTED') assert.equal((await request('/orders/start', driverToken, { orderId: active.id })).status, 200);
    const adminSocket = await socket(adminToken);
    const statusEvent = nextSocketEvent<{ driverId: string; isAvailable: boolean }>(adminSocket, 'driver:status');
    const online = await request('/driver/status', driverToken, { isOnline: true, isAvailable: true });
    assert.equal(online.status, 200);
    assert.equal(online.data.isAvailable, false);
    assert.equal((await statusEvent).isAvailable, false);
    // Imported rows/old clients must not make the monitoring UI claim a busy driver is free.
    await prisma.driver.update({ where: { id: driver.id }, data: { isAvailable: true } });
    const list = await request('/admin/drivers?status=APPROVED&limit=100', adminToken);
    assert.equal(list.data.items.find((item: { id: string }) => item.id === driver.id).isAvailable, false);
    const detail = (await request(`/admin/drivers/${driver.id}`, adminToken)).data;
    assert.equal(detail.isAvailable, false);
    assert.equal(detail.hasActiveTrip, true);
    assert.equal(list.data.items.find((item: { id: string }) => item.id === driver.id).hasActiveTrip, true);
    const regions = await request('/districts', driverToken);
    assert.equal(regions.data.find((item: { id: string }) => item.id === regionId).freeDrivers, 0);
    const offer = await request('/admin/orders', adminToken, { districtId: regionId, priceEstimated: 10, clientPhone: '+99365000000', privateOfferDriverId: driver.id });
    assert.equal(offer.status, 409);
    const next = await order(10);
    assert.equal((await request('/orders/accept', driverToken, { orderId: next.id, arrivalMinutes: 5 })).status, 409);
    assert.equal((await request('/orders/current', driverToken)).data.id, active.id);
    adminSocket.disconnect();
  });
}
test('today operations use the Ashgabat creation cohort, terminal denominator and honest acceptance samples', async () => {
  assert.equal((await request('/admin/overview/today')).status, 401);
  assert.equal((await request('/admin/overview/today', driverToken)).status, 403);
  const empty = await request('/admin/overview/today', adminToken);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.timeZone, 'Asia/Ashgabat');
  assert.match(empty.data.dayStart, /T19:00:00\.000Z$/);
  assert.match(empty.data.dayEnd, /T19:00:00\.000Z$/);
  assert.equal(empty.data.dayEnd.slice(0, 10), empty.data.date);
  assert.equal(Date.parse(empty.data.dayEnd) - Date.parse(empty.data.dayStart), 86_400_000);
  assert.deepEqual(empty.data.cohort, { created: 0, completed: 0, cancelled: 0, unfinished: 0, terminal: 0, completionRate: null, cancellationRate: null });
  assert.deepEqual(empty.data.acceptance, { samples: 0, missing: 0, invalid: 0, medianSeconds: null, p90Seconds: null });
  assert.deepEqual(empty.data.waiting, { publicOrders: 0, privateReservations: 0, oldestSeconds: null });
  const start = Date.parse(empty.data.dayStart);
  const end = Date.parse(empty.data.dayEnd);
  const baseOrder = { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32 };
  await prisma.order.createMany({ data: [
    { ...baseOrder, status: 'COMPLETED', createdAt: new Date(start), acceptedAt: new Date(start + 10_000) },
    { ...baseOrder, status: 'CANCELLED', createdAt: new Date(start + 1000), acceptedAt: new Date(start + 31_000) },
    { ...baseOrder, status: 'STARTED', createdAt: new Date(start + 2000), acceptedAt: new Date(start + 92_000) },
    { ...baseOrder, status: 'CANCELLED', createdAt: new Date(start + 3000) },
    { ...baseOrder, status: 'ACCEPTED', createdAt: new Date(start + 4000), acceptedAt: new Date(start + 3999) },
    // One millisecond outside each bound must not enter today's cohort.
    { ...baseOrder, status: 'COMPLETED', createdAt: new Date(start - 1), acceptedAt: new Date(start + 999_999) },
    { ...baseOrder, status: 'CANCELLED', createdAt: new Date(end), acceptedAt: new Date(end + 999_999) }
  ] });
  const result = await request('/admin/overview/today', adminToken);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.cohort, { created: 5, completed: 1, cancelled: 2, unfinished: 2, terminal: 3, completionRate: 1 / 3, cancellationRate: 2 / 3 });
  assert.deepEqual(result.data.acceptance, { samples: 3, missing: 1, invalid: 1, medianSeconds: 30, p90Seconds: 78 });
});

test('live waiting includes overnight public orders and expired reservations but separates active private offers', async () => {
  const clock = await request('/admin/overview/today', adminToken);
  assert.equal(clock.status, 200);
  const start = Date.parse(clock.data.dayStart);
  const now = Date.now();
  const drivers = await prisma.driver.findMany({ take: 2 });
  const baseOrder = { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32 };
  await prisma.order.createMany({ data: [
    { ...baseOrder, status: 'NEW', createdAt: new Date(start - 60_000) },
    // A fresh unreserved order is public and globally claimable.
    { ...baseOrder, status: 'NEW', createdAt: new Date(now) },
    { ...baseOrder, status: 'NEW', createdAt: new Date(now), privateOfferDriverId: drivers[0].id, privateOfferExpiresAt: new Date(now - 1) },
    { ...baseOrder, status: 'NEW', createdAt: new Date(start - 120_000), privateOfferDriverId: drivers[1].id, privateOfferExpiresAt: new Date(now + 60_000) },
    { ...baseOrder, status: 'ACCEPTED', createdAt: new Date(start - 180_000), acceptedAt: new Date(now) }
  ] });
  const result = await request('/admin/overview/today', adminToken);
  assert.equal(result.data.waiting.publicOrders, 3);
  assert.equal(result.data.waiting.privateReservations, 1);
  const expectedOldest = (now - start + 60_000) / 1000;
  assert.ok(result.data.waiting.oldestSeconds >= expectedOldest);
  assert.ok(result.data.waiting.oldestSeconds < expectedOldest + 5);
  assert.equal(result.data.cohort.created, 2);
  assert.equal(result.data.cohort.unfinished, 2);
  assert.equal(result.data.cohort.completionRate, null);
  assert.equal(result.data.cohort.cancellationRate, null);
});


test('today acceptance includes a cohort order accepted after the reporting day ends', async () => {
  const clock = await request('/admin/overview/today', adminToken);
  const end = Date.parse(clock.data.dayEnd);
  await prisma.order.create({ data: {
    districtId: regionId, pickupLat: 37.96, pickupLng: 58.32,
    status: 'CANCELLED', createdAt: new Date(end - 1), acceptedAt: new Date(end + 59_999)
  } });
  const result = await request('/admin/overview/today', adminToken);
  assert.equal(result.data.cohort.created, 1);
  assert.equal(result.data.cohort.cancelled, 1);
  assert.equal(result.data.cohort.cancellationRate, 1);
  assert.deepEqual(result.data.acceptance, { samples: 1, missing: 0, invalid: 0, medianSeconds: 60, p90Seconds: 60 });
});

test('stopped private orders remain unfinished in today cohort but leave the live waiting queue', async () => {
  const clock = (await request('/admin/overview/today', adminToken)).data;
  const start = Date.parse(clock.dayStart);
  const driver = (await request('/driver/profile', driverToken)).data;
  await prisma.order.createMany({ data: [
    { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'NEW', createdAt: new Date(start + 1), privateOfferStoppedAt: new Date() },
    { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'NEW', createdAt: new Date(start - 86_400_000), privateOfferStoppedAt: new Date() },
    { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'NEW', createdAt: new Date(start + 2), publicRegionOnlyUntil: new Date(Date.now() + 20_000) },
    { districtId: regionId, pickupLat: 37.96, pickupLng: 58.32, status: 'NEW', createdAt: new Date(start + 3), privateOfferDriverId: driver.id, privateOfferExpiresAt: new Date(Date.now() + 20_000) }
  ] });
  const result = (await request('/admin/overview/today', adminToken)).data;
  assert.equal(result.cohort.created, 3);
  assert.equal(result.cohort.unfinished, 3);
  assert.deepEqual({ publicOrders: result.waiting.publicOrders, privateReservations: result.waiting.privateReservations }, { publicOrders: 1, privateReservations: 1 });
  const expectedOldest = (Date.parse(result.asOf) - (start + 2)) / 1000;
  assert.ok(Math.abs(result.waiting.oldestSeconds - expectedOldest) < 0.01);
});

test('a started trip cannot be dispatcher-cancelled or refunded even while manual completion races it', async () => {
  const created = await order(30);
  const body = { orderId: created.id };
  for (const action of ['accept', 'waiting', 'start']) assert.equal((await request(`/orders/${action}`, driverToken, body)).status, 200);
  const before = (await request('/driver/history', driverToken)).data;
  const profile = (await request('/driver/profile', driverToken)).data;
  assert.equal((await request(`/admin/orders/${created.id}/cancel`, adminToken, { reason: 'Must not refund a drive in progress' })).status, 409);
  assert.equal((await request('/orders/current', driverToken)).data.status, 'STARTED');
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '470');
  assert.equal((await request('/driver/profile', driverToken)).data.isAvailable, profile.isAvailable);
  assert.deepEqual((await request('/driver/history', driverToken)).data.transactions, before.transactions);
  assert.equal((await request(`/admin/orders/${created.id}/force-resolve`, adminToken, {})).status, 400);
  const [cancelled, resolved] = await Promise.all([
    request(`/admin/orders/${created.id}/cancel`, adminToken, { reason: 'Racing forbidden cancellation' }),
    request(`/admin/orders/${created.id}/force-resolve`, adminToken, { reason: 'Passenger confirmed arrival by phone' })
  ]);
  assert.equal(cancelled.status, 409);
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.status, 'COMPLETED');
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '470');
  const history = (await request('/driver/history', driverToken)).data;
  assert.equal(history.transactions.total, 1);
  assert.equal(history.transactions.items[0].type, 'PAYMENT');
  assert.equal(history.orders.items[0].driverId, profile.id);
});


test('driver cancels before arrival without a reason and cannot cancel WAITING or STARTED', async () => {
  const created = await order();
  const body = { orderId: created.id };
  assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
  const results = await Promise.all([1, 2].map(() => request('/orders/cancel', driverToken, body)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  assert.equal((await request('/orders/current', driverToken)).data, null);
  const next = await order();
  const nextBody = { orderId: next.id };
  for (const action of ['accept', 'waiting']) assert.equal((await request(`/orders/${action}`, driverToken, nextBody)).status, 200);
  assert.equal((await request('/orders/cancel', driverToken, nextBody)).status, 409);
  assert.equal((await request('/orders/current', driverToken)).data.status, 'WAITING');
  assert.equal((await request('/orders/start', driverToken, nextBody)).status, 200);
  assert.equal((await request('/orders/cancel', driverToken, nextBody)).status, 409);
  assert.equal((await request('/orders/current', driverToken)).data.status, 'STARTED');
});

test('financial commands reject sub-cent, overflow and reversed direction amounts without writes', async () => {
  const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
  for (const body of [
    { amount: 0.001, type: 'TOPUP' }, { amount: 0.005, type: 'TOPUP' },
    { amount: 10000000000, type: 'TOPUP' }, { amount: 1e100, type: 'TOPUP' },
    { amount: -10, type: 'TOPUP' }, { amount: 10, type: 'WITHDRAWAL' },
    { amount: -10, type: 'BONUS' }, { amount: 0, type: 'ADJUSTMENT' }
  ]) {
    assert.equal((await request(`/admin/drivers/${driver.id}/balance`, adminToken, body)).status, 400, JSON.stringify(body));
  }
  for (const priceEstimated of [0.001, 0.005, 100000000, 1e100]) {
    assert.equal((await request('/admin/orders', adminToken, { districtId: regionId, clientPhone: '+99365000000', priceEstimated })).status, 400);
  }
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  assert.equal((await request(`/admin/drivers/${driver.id}/history`, adminToken)).data.transactions.total, 0);
});

test('cent amounts match balance, history and socket and wallet overflow leaves no ledger entry', async () => {
  const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
  const admin = await socket(adminToken);
  const event = nextSocketEvent<{ amount: string }>(admin, 'balance:updated');
  const credited = await request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 0.01, type: 'TOPUP' });
  assert.equal(credited.status, 200);
  assert.equal(credited.data.balance.amount, '500.01');
  assert.equal(credited.data.transaction.amount, '0.01');
  assert.equal(credited.data.transaction.balanceAfter, '500.01');
  assert.equal((await event).amount, '500.01');
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500.01');
  await prisma.balance.update({ where: { userId: driver.userId }, data: { amount: '9999999999.99' } });
  assert.equal((await request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 0.01, type: 'TOPUP' })).status, 400);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '9999999999.99');
  assert.equal((await request(`/admin/drivers/${driver.id}/history`, adminToken)).data.transactions.total, 1);
  const order = await request('/admin/orders', adminToken, { districtId: regionId, clientPhone: '+99365000000', priceEstimated: 99999999.99 });
  assert.equal(order.status, 201);
  assert.equal(order.data.priceEstimated, '99999999.99');
});


test('topups respect total limit while hold release does not require refund headroom', async () => {
  const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
  const created = await order(30);
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 200);
  assert.equal((await request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 9999999529.99, type: 'TOPUP' })).status, 400);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  assert.equal((await request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 9999999499.99, type: 'TOPUP' })).status, 200);
  assert.equal((await request(`/admin/orders/${created.id}/cancel`, adminToken, { reason: 'Synthetic headroom proof' })).status, 200);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '9999999999.99');
  const history = await request(`/admin/drivers/${driver.id}/history`, adminToken);
  assert.equal(history.data.transactions.total, 1);
});

test('deactivating a driver preserves ledger and completed attribution while revoking access', async () => {
  const created = await request('/admin/drivers', adminToken, { phone: '+99361999981', fullName: 'Retained driver', password });
  assert.equal(created.status, 201);
  const id = created.data.id;
  const auth = await request('/auth/login', '', { phone: '+99361999981', password, deviceId: 'retained-device' });
  const token = auth.data.accessToken;
  const session = await socket(token);
  assert.equal((await request(`/admin/drivers/${id}/balance`, adminToken, { amount: 30, type: 'TOPUP', note: 'Retained funding' })).status, 200);
  await startShift(token, 58.32);
  await request('/driver/status', token, { isOnline: true });
  const shift = await request('/driver/shift', token, { deviceId: 'retained-device', refreshToken: auth.data.refreshToken });
  assert.equal(shift.status, 201);
  const completed = await order(30);
  await prisma.order.update({ where: { id: completed.id }, data: { driverId: id, status: 'COMPLETED', completedAt: new Date() } });
  const disconnected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Deactivated session remained connected')), 3000);
    session.once('disconnect', () => { clearTimeout(timer); resolve(); });
  });
  const deleted = await fetch(`${base}/admin/drivers/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(deleted.status, 204);
  await disconnected;
  const retained = await request(`/admin/drivers/${id}`, adminToken);
  assert.equal(retained.status, 200);
  assert.equal(retained.data.id, id);
  assert.equal(retained.data.status, 'BLOCKED');
  assert.equal(retained.data.user.balance.amount, '30');
  const history = await request(`/admin/drivers/${id}/history`, adminToken);
  assert.equal(history.data.transactions.total, 1);
  assert.equal(history.data.transactions.items[0].note, 'Retained funding');
  assert.equal(history.data.orders.items[0].driverId, id);
  assert.equal((await request('/driver/me', token)).status, 401);
  assert.equal((await request('/auth/refresh', '', { refreshToken: auth.data.refreshToken })).status, 401);
  assert.equal((await request('/native-shift/tick', shift.data.shiftToken, { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() })).status, 401);
  assert.equal((await request('/auth/login', '', { phone: '+99361999981', password, deviceId: 'synthetic-approved-browser' })).status, 401);
  const deletedProfile = await request(`/admin/drivers/${id}`, adminToken);
  assert.equal(deletedProfile.data.accountDeleted, true);
  assert.equal((await request(`/admin/drivers/${id}/unblock`, adminToken, {})).status, 409);
  assert.equal((await request(`/admin/drivers/${id}/approve`, adminToken, {})).status, 409);
  assert.equal((await request('/auth/login', '', { phone: '+99361999981', password, deviceId: 'synthetic-approved-browser' })).status, 401);
});

test('deactivation refuses an active trip and preserves its balance and driver linkage', async () => {
  const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
  const created = await order(30);
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 200);
  for (const status of ['ACCEPTED', 'WAITING', 'STARTED'] as const) {
    await prisma.order.update({ where: { id: created.id }, data: { status } });
    const response = await fetch(`${base}/admin/drivers/${driver.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
    assert.equal(response.status, 409);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
    assert.equal((await request('/orders/current', driverToken)).data.driverId, driver.id);
  }
});


test('balance operation retries debit once, retain original result and reject changed intent', async () => {
  const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
  const path = `/admin/drivers/${driver.id}/balance`;
  const operationId = randomUUID();
  const body = { operationId, amount: -30, type: 'WITHDRAWAL', note: 'One intent' };
  const responses = await Promise.all(Array.from({ length: 8 }, () => request(path, adminToken, body)));
  assert.ok(responses.every(result => result.status === 200));
  assert.equal(new Set(responses.map(result => result.data.transaction.id)).size, 1);
  assert.ok(responses.every(result => result.data.balance.amount === '470'));
  assert.equal((await request(path, adminToken, { amount: 15, type: 'TOPUP' })).status, 200);
  assert.equal((await request(path, adminToken, body)).data.balance.amount, '470');
  assert.equal((await request(path, adminToken, { ...body, amount: -31 })).status, 409);
  const other = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000102' } } });
  assert.equal((await request(`/admin/drivers/${other.id}/balance`, adminToken, body)).status, 409);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '485');
  assert.equal((await request(`${path.replace('/balance', '/history')}`, adminToken)).data.transactions.total, 2);
  const missing = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ amount: 10, type: 'TOPUP' }) });
  assert.equal(missing.status, 400);
});

test('operation IDs are scoped to the acting dispatcher and rollback permits a safe retry', async () => {
  const admin = await prisma.user.create({ data: { phone: '+99361999982', fullName: 'Second financial actor', role: 'ADMIN', passwordHash: await bcrypt.hash(password, 4), admin: { create: { permissionLevel: 'SUPER' } } } });
  const secondToken = await login(admin.phone);
  const driver = await prisma.driver.findFirstOrThrow({ where: { user: { phone: '+99360000101' } } });
  const path = `/admin/drivers/${driver.id}/balance`;
  const body = { operationId: randomUUID(), amount: 15, type: 'TOPUP' };
  try {
    assert.equal((await request(path, adminToken, body)).status, 200);
    assert.equal((await request(path, secondToken, body)).status, 200);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '530');
    assert.equal((await request(path.replace('/balance', '/history'), adminToken)).data.transactions.total, 2);
    const retry = { operationId: randomUUID(), amount: 30, type: 'TOPUP' };
    await prisma.$executeRawUnsafe(`ALTER TABLE transactions ADD CONSTRAINT fail_test_adjust CHECK (type <> 'TOPUP') NOT VALID`);
    try {
      assert.equal((await request(path, adminToken, retry)).status, 500);
      assert.equal((await request('/driver/balance', driverToken)).data.amount, '530');
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE transactions DROP CONSTRAINT fail_test_adjust');
    }
    assert.equal((await request(path, adminToken, retry)).status, 200);
    assert.equal((await request(path, adminToken, retry)).status, 200);
    assert.equal((await request('/driver/balance', driverToken)).data.amount, '560');
    assert.equal((await request(path.replace('/balance', '/history'), adminToken)).data.transactions.total, 3);
  } finally {
    await prisma.user.delete({ where: { id: admin.id } });
  }
});


test('explicit logout rejects rotated refresh replay and immediately revokes only that user HTTP and socket authority', async () => {
  const phone = '+99361999121';
  assert.equal((await request('/admin/drivers', adminToken, { phone, fullName: 'Logout fixture', password })).status, 201);
  const auth = await request('/auth/login', '', { phone, password, deviceId: 'logout-fixture-device' });
  assert.equal(auth.status, 200);
  const connected = await socket(auth.data.accessToken);
  const rotated = await request('/auth/refresh', '', { refreshToken: auth.data.refreshToken });
  assert.equal(rotated.status, 200);
  assert.equal((await request('/auth/refresh', '', { refreshToken: auth.data.refreshToken })).status, 200, 'legitimate rotation races retain grace');
  await request('/auth/logout', '', { refreshToken: auth.data.refreshToken });
  assert.equal((await request('/auth/refresh', '', { refreshToken: auth.data.refreshToken })).status, 401);
  assert.equal((await request('/auth/refresh', '', { refreshToken: rotated.data.refreshToken })).status, 401);
  assert.equal((await request('/driver/profile', auth.data.accessToken)).status, 401);
  assert.equal((await request('/driver/profile', rotated.data.accessToken)).status, 401);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(connected.connected, false);
  assert.equal((await request('/admin/drivers', adminToken)).status, 200);
  assert.equal((await request('/driver/profile', driverToken)).status, 200);
  const fresh = await request('/auth/login', '', { phone, password, deviceId: 'logout-fixture-device' });
  const freshSocket = await socket(fresh.data.accessToken);
  await request('/auth/logout', '', { refreshToken: auth.data.refreshToken });
  assert.equal((await request('/driver/profile', fresh.data.accessToken)).status, 200, 'an obsolete logout cannot revoke a later generation');
  assert.equal(freshSocket.connected, true);
});

test('an approved account can log in on a new installation but still requires signed installation identity', async () => {
  const phone = '+99361999122';
  assert.equal((await request('/admin/drivers', adminToken, { phone, fullName: 'Binding fixture', password })).status, 201);
  const auth = await request('/auth/login', '', { phone, password, deviceId: 'approved-fixture-device' });
  assert.equal(auth.status, 200);
  assert.equal((await request('/auth/login', '', { phone, password })).status, 400);
  assert.equal((await request('/auth/login', '', { phone, password, deviceId: 'unapproved-fixture-device' })).status, 200);
  assert.equal((await request('/driver/profile', auth.data.accessToken)).status, 200);
});


test('signed-in installations keep independent sessions and only one owns the shift', async () => {
  const phone = '+99361999123';
  const created = await request('/admin/drivers', adminToken, { phone, fullName: 'Device switch fixture', password });
  const first = await request('/auth/login', '', { phone, password, deviceId: 'first-approved-device' });
  assert.equal(first.status, 200);
  const connected = await socket(first.data.accessToken);
  assert.equal((await request('/driver/profile', first.data.accessToken)).status, 200);
  const second = await request('/auth/login', '', { phone, password, deviceId: 'second-approved-device' });
  assert.equal(second.status, 200);
  assert.equal((await request('/driver/profile', second.data.accessToken)).status, 200);
  assert.equal((await request('/driver/profile', first.data.accessToken)).status, 200);
  const refreshed = await request('/auth/refresh', '', { refreshToken: first.data.refreshToken });
  assert.equal(refreshed.status, 200);
  assert.equal(connected.connected, true);
  const firstToken = refreshed.data.accessToken;
  const secondToken = second.data.accessToken;
  await prisma.balance.update({ where: { userId: created.data.userId }, data: { amount: 500 } });
  const starts = await Promise.all([firstToken, secondToken].map(token => startShift(token)));
  assert.deepEqual(starts.map(result => result.status).sort(), [200, 409]);
  const ownerIndex = starts[0].status === 200 ? 0 : 1;
  const ownerToken = [firstToken, secondToken][ownerIndex];
  const spectatorToken = [firstToken, secondToken][1 - ownerIndex];
  const ownerSession = [refreshed.data, second.data][ownerIndex];
  const spectatorSession = [refreshed.data, second.data][1 - ownerIndex];
  const ownerDevice = ['first-approved-device', 'second-approved-device'][ownerIndex];
  assert.equal((await request('/driver/profile', ownerToken)).data.canControlShift, true);
  assert.equal((await request('/driver/profile', spectatorToken)).data.canControlShift, false);
  assert.equal((await request('/driver/location', spectatorToken, { lat: 30, lng: 50 })).status, 409);
  assert.equal((await request('/driver/status', spectatorToken, { isOnline: false })).status, 409);
  const job = await order();
  assert.equal((await request('/orders/accept', spectatorToken, { orderId: job.id, etaMinutes: 5 })).status, 409);
  const native = await request('/driver/shift', ownerToken, { deviceId: ownerDevice, refreshToken: ownerSession.refreshToken });
  assert.equal(native.status, 201);
  assert.equal((await request('/driver/shift', ownerToken, { deviceId: ownerDevice, refreshToken: ownerSession.refreshToken })).status, 409, 'a duplicate start cannot replace a running native credential');
  assert.equal((await request('/orders/accept', ownerToken, { orderId: job.id, etaMinutes: 5 })).status, 200);
  for (const path of ['waiting', 'start', 'complete', 'cancel']) assert.equal((await request(`/orders/${path}`, spectatorToken, { orderId: job.id, reason: 'Not owner' })).status, 409);
  assert.equal((await request('/driver/district', spectatorToken, { districtId: otherRegionId })).status, 410);
  assert.equal((await request('/driver/shift', spectatorToken, { deviceId: ownerDevice, refreshToken: ownerSession.refreshToken })).status, 403);
  assert.equal((await request('/driver/shift/stop', spectatorToken, {})).status, 409);
  assert.equal((await request('/auth/logout', '', { refreshToken: spectatorSession.refreshToken })).status, 204);
  assert.equal((await request('/driver/profile', ownerToken)).data.isOnline, true);
  assert.equal((await request('/native-shift/tick', native.data.shiftToken, { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() })).status, 200);
  assert.equal((await request('/driver/status', ownerToken, { isOnline: false })).status, 200);
  const spectator = await request('/auth/login', '', { phone, password, deviceId: ['first-approved-device', 'second-approved-device'][1 - ownerIndex] });
  assert.equal((await request('/orders/current', spectator.data.accessToken)).data.id, job.id, 'transfer retains the assigned trip');
  assert.equal((await request('/orders/waiting', spectator.data.accessToken, { orderId: job.id })).status, 200, 'offline recovery does not require GPS or shift');
  assert.equal((await startShift(spectator.data.accessToken)).status, 200);
  assert.equal((await request('/orders/start', ownerToken, { orderId: job.id })).status, 409);
  assert.equal((await request('/orders/start', spectator.data.accessToken, { orderId: job.id })).status, 200);
  assert.equal((await request('/native-shift/tick', native.data.shiftToken, { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() })).status, 401);

});

test('a password reset winning the user lock cannot authorize an in-flight old-password login', async () => {
  const phone = '+99361999124';
  const created = await request('/admin/drivers', adminToken, { phone, fullName: 'Login race fixture', password });
  let release!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const ready = new Promise<void>(resolve => locked = resolve);
  const blocker = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE phone = ${phone} FOR UPDATE`;
    locked(); await gate;
  }, { timeout: 10000 });
  async function waitForBlocked(count: number) {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      const [row] = await prisma.$queryRaw<Array<{ count: number }>>`SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`;
      if (row.count >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Expected HTTP operations to reach the fixture database barrier');
  }
  await ready;
  const resetting = request(`/admin/drivers/${created.data.id}/password`, adminToken, { password: '654321', passwordConfirmation: '654321' });
  let pending: ReturnType<typeof request> | undefined;
  try {
    await waitForBlocked(1);
    pending = request('/auth/login', '', { phone, password, deviceId: 'racing-login-device' });
    await waitForBlocked(2);
  } finally { release(); await blocker; }
  assert.equal((await resetting).status, 200);
  assert.ok(pending);
  assert.equal((await pending).status, 401);
  const current = await request('/auth/login', '', { phone, password: '654321', deviceId: 'racing-login-device' });
  assert.equal(current.status, 200);
  assert.equal((await request('/driver/profile', current.data.accessToken)).status, 200);
});


test('dispatcher logout revokes its own HTTP and socket authority without signing out another dispatcher', async () => {
  const phone = '+99361999125';
  await prisma.user.create({ data: { phone, fullName: 'Logout dispatcher fixture', role: 'ADMIN', passwordHash: await bcrypt.hash(password, 4), admin: { create: { permissionLevel: 'SUPER' } } } });
  const auth = await request('/auth/login', '', { phone, password });
  const own = await socket(auth.data.accessToken);
  const unaffected = await socket(adminToken);
  assert.equal((await request('/auth/logout', '', { refreshToken: auth.data.refreshToken })).status, 204);
  assert.equal((await request('/admin/drivers', auth.data.accessToken)).status, 401);
  assert.equal((await request('/admin/drivers', adminToken)).status, 200);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(own.connected, false);
  assert.equal(unaffected.connected, true);
  const refused = connect(base, { auth: { token: auth.data.accessToken }, transports: ['websocket'], reconnection: false, forceNew: true });
  clients.push(refused);
  const error = await new Promise<Error>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Revoked socket did not reject authentication')), 3000);
    refused.once('connect_error', error => { clearTimeout(timer); resolve(error); });
  });
  assert.equal(error.message, 'unauthorized');
});


test('logging in a new installation preserves the first installation live native shift', async () => {
  const phone = '+99361999127';
  const created = await request('/admin/drivers', adminToken, { phone, fullName: 'Live device approval fixture', password });
  await prisma.balance.update({ where: { userId: created.data.userId }, data: { amount: 500 } });
  const first = await request('/auth/login', '', { phone, password, deviceId: 'live-device-first' });
  const firstSocket = await socket(first.data.accessToken);
  assert.equal((await startShift(first.data.accessToken, 58.32)).status, 200);
  assert.equal((await request('/driver/status', first.data.accessToken, { isOnline: true })).status, 200);
  const native = await request('/driver/shift', first.data.accessToken, { deviceId: 'live-device-first', refreshToken: first.data.refreshToken });
  assert.equal(native.status, 201);
  const second = await request('/auth/login', '', { phone, password, deviceId: 'live-device-second' });
  assert.equal(second.status, 200);
  const secondSocket = await socket(second.data.accessToken);
  assert.equal(firstSocket.connected, true);
  assert.equal((await request('/driver/profile', first.data.accessToken)).data.isOnline, true);
  assert.equal((await request('/driver/profile', second.data.accessToken)).data.canControlShift, false);
  assert.equal((await request('/driver/shift', second.data.accessToken, { deviceId: 'live-device-second', refreshToken: second.data.refreshToken })).status, 409);
  const fix = { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() };
  assert.equal((await request('/native-shift/tick', native.data.shiftToken, fix)).status, 200);
  assert.equal((await request('/auth/logout', '', { refreshToken: second.data.refreshToken })).status, 204);
  assert.equal(firstSocket.connected, true);
  assert.equal(secondSocket.connected, false);
  assert.equal((await request('/native-shift/tick', native.data.shiftToken, { ...fix, recordedAt: new Date().toISOString() })).status, 200);
  assert.equal((await request('/driver/profile', first.data.accessToken)).data.isOnline, true);
});


test('blocking then unblocking a driver never revives any installation session', async () => {
  const phone = '+99361999128';
  const created = await request('/admin/drivers', adminToken, { phone, fullName: 'Block session fixture', password });
  const first = await request('/auth/login', '', { phone, password, deviceId: 'block-device-first' });
  const second = await request('/auth/login', '', { phone, password, deviceId: 'block-device-second' });
  assert.equal((await request(`/admin/drivers/${created.data.id}/block`, adminToken, { reason: 'Synthetic account safety block' })).status, 200);
  assert.equal((await request(`/admin/drivers/${created.data.id}/unblock`, adminToken, {})).status, 200);
  for (const session of [first.data, second.data]) {
    assert.equal((await request('/driver/profile', session.accessToken)).status, 401);
    assert.equal((await request('/auth/refresh', '', { refreshToken: session.refreshToken })).status, 401);
  }
  assert.equal((await request('/auth/login', '', { phone, password, deviceId: 'block-device-first' })).status, 200);
});

for (const expired of ['lease', 'gps'] as const) {
  test(`an expired ${expired} releases shift ownership without letting the old native credential revive it`, async () => {
    const phone = expired === 'lease' ? '+99361999129' : '+99361999130';
    const created = await request('/admin/drivers', adminToken, { phone, fullName: 'Expired owner fixture', password });
    await prisma.balance.update({ where: { userId: created.data.userId }, data: { amount: 500 } });
    const first = await request('/auth/login', '', { phone, password, deviceId: 'expiry-first-device' });
    const second = await request('/auth/login', '', { phone, password, deviceId: 'expiry-second-device' });
    assert.equal((await startShift(first.data.accessToken, 58.32)).status, 200);
    assert.equal((await request('/driver/status', first.data.accessToken, { isOnline: true })).status, 200);
    const native = await request('/driver/shift', first.data.accessToken, { deviceId: 'expiry-first-device', refreshToken: first.data.refreshToken });
    assert.equal(native.status, 201);
    if (expired === 'lease') {
      await prisma.$executeRaw`UPDATE native_shift_leases SET expires_at = NOW() - INTERVAL '1 second' WHERE driver_id = ${created.data.id}`;
      const profile = await request('/driver/profile', second.data.accessToken);
      assert.equal(profile.data.isOnline, false, 'an expired native service cannot remain the shift owner even when cached GPS is fresh');
      assert.equal(profile.data.canControlShift, true);
    } else {
      await prisma.driver.update({ where: { id: created.data.id }, data: { lastLocationAt: new Date(Date.now() - 61000) } });
    }
    assert.equal((await startShift(second.data.accessToken, 58.42)).status, 200);
    assert.equal((await request('/driver/status', second.data.accessToken, { isOnline: true })).status, 200);
    assert.equal((await request('/native-shift/tick', native.data.shiftToken, { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() })).status, 401);
    const secondProfile = await request('/driver/profile', second.data.accessToken);
    assert.equal(secondProfile.data.canControlShift, true);
    assert.equal(Number(secondProfile.data.lastLng), 58.42, 'the old native service never overwrites the replacement position');
    assert.equal((await request('/driver/status', first.data.accessToken, { isOnline: true })).status, 409);
  });
}

test('dispatcher sign out everywhere revokes both installations and preserves the assigned trip and account', async () => {
  const phone = '+99361999131';
  const created = await request('/admin/drivers', adminToken, { phone, fullName: 'Global logout fixture', password });
  assert.equal(created.status, 201);
  await prisma.balance.update({ where: { userId: created.data.userId }, data: { amount: 500 } });
  const first = await request('/auth/login', '', { phone, password, deviceId: 'global-first' });
  const second = await request('/auth/login', '', { phone, password, deviceId: 'global-second' });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const connections = await Promise.all([first, second].map(session => socket(session.data.accessToken)));
  const capabilities = await Promise.all([first, second].map(session => request('/driver/notifications/registration', session.data.accessToken, { enabled: true })));
  assert.ok(capabilities.every(result => result.status === 200));
  assert.equal((await startShift(first.data.accessToken, 58.32)).status, 200);
  assert.equal((await request('/driver/status', first.data.accessToken, { isOnline: true })).status, 200);
  const native = await request('/driver/shift', first.data.accessToken, { deviceId: 'global-first', refreshToken: first.data.refreshToken });
  assert.equal(native.status, 201);
  const job = await order();
  assert.equal((await request('/orders/accept', first.data.accessToken, { orderId: job.id })).status, 200);
  assert.equal((await request(`/admin/drivers/${created.data.id}/sign-out-everywhere`, second.data.accessToken, {})).status, 403);
  const disconnected = connections.map(connection => nextSocketEvent(connection, 'disconnect'));
  const result = await request(`/admin/drivers/${created.data.id}/sign-out-everywhere`, adminToken, {});
  assert.equal(result.status, 200);
  assert.match(result.data.message, /сеансы.*завершены/i);
  await Promise.all(disconnected);
  for (const session of [first, second]) {
    assert.equal((await request('/driver/profile', session.data.accessToken)).status, 401);
    assert.equal((await request('/auth/refresh', '', { refreshToken: session.data.refreshToken })).status, 401);
  }
  for (const registration of capabilities) assert.equal((await request('/native-notifications/event', registration.data.notificationToken, { eventId: 'chat:obsolete' })).status, 401);
  assert.equal((await request('/native-shift/tick', native.data.shiftToken, { lat: 37.96, lng: 58.32, recordedAt: new Date().toISOString() })).status, 401);
  const recovered = await request('/auth/login', '', { phone, password, deviceId: 'global-third' });
  assert.equal(recovered.status, 200, 'unchanged credentials still work on another installation');
  const profile = await request('/driver/profile', recovered.data.accessToken);
  assert.equal(profile.data.status, 'APPROVED');
  assert.equal(profile.data.isOnline, false);
  assert.equal((await request('/driver/balance', recovered.data.accessToken)).data.amount, '500');
  assert.equal((await request('/orders/current', recovered.data.accessToken)).data.id, job.id);
  assert.equal((await request('/orders/waiting', recovered.data.accessToken, { orderId: job.id })).status, 200, 'the assigned trip can be recovered without a shift');
});

test('offline installations cannot overwrite the shared position and Online acquires ownership with its own fresh GPS atomically', async () => {
  const phone = '+99361999132';
  const created = await request('/admin/drivers', adminToken, { phone, fullName: 'Local GPS fixture', password });
  await prisma.balance.update({ where: { userId: created.data.userId }, data: { amount: 500 } });
  const first = await request('/auth/login', '', { phone, password, deviceId: 'local-first' });
  const second = await request('/auth/login', '', { phone, password, deviceId: 'local-second' });
  for (const session of [first, second]) {
    assert.equal((await request('/driver/location', session.data.accessToken, { lat: 37.96, lng: 58.32 })).status, 403);
    const profile = (await request('/driver/profile', session.data.accessToken)).data;
    assert.equal(profile.lastLat, null);
    assert.equal(profile.districtId, null);
  }
  assert.equal((await request('/driver/status', first.data.accessToken, { isOnline: true })).status, 403);
  const stale = await request('/driver/status', first.data.accessToken, { isOnline: true, position: { lat: 37.96, lng: 58.32, capturedAt: Date.now() - 61000 } });
  assert.equal(stale.status, 400);
  assert.equal((await request('/driver/profile', first.data.accessToken)).data.lastLat, null);
  const results = await Promise.all([first, second].map((session, index) => request('/driver/status', session.data.accessToken, { isOnline: true, position: { lat: 37.96, lng: index === 0 ? 58.32 : 58.42, capturedAt: Date.now() } })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? 0 : 1;
  const profile = (await request('/driver/profile', first.data.accessToken)).data;
  assert.equal(Number(profile.lastLng), winner === 0 ? 58.32 : 58.42);
  assert.equal(profile.districtId, winner === 0 ? regionId : otherRegionId);
  assert.equal((await request('/driver/status', [first, second][winner].data.accessToken, { isOnline: false })).status, 200);
  assert.equal((await request('/driver/location', [first, second][winner].data.accessToken, { lat: 30, lng: 50 })).status, 403);
  const offline = (await request('/driver/profile', first.data.accessToken)).data;
  assert.equal(Number(offline.lastLng), winner === 0 ? 58.32 : 58.42);
});

test('blocking requires a reason and revokes access without cancelling or refunding a started trip', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  const job = await order(30);
  for (const action of ['accept', 'waiting', 'start']) assert.equal((await request(`/orders/${action}`, driverToken, { orderId: job.id })).status, 200);
  for (const body of [{}, { reason: '   ' }]) assert.equal((await request(`/admin/drivers/${driver.id}/block`, adminToken, body)).status, 400);
  assert.equal((await request('/driver/profile', driverToken)).data.isOnline, true);
  assert.equal((await request(`/admin/drivers/${driver.id}/block`, adminToken, { reason: 'Dispatcher safety review' })).status, 200);
  assert.equal((await request('/driver/profile', driverToken)).status, 401);
  const detail = (await request(`/admin/drivers/${driver.id}`, adminToken)).data;
  assert.equal(detail.status, 'BLOCKED');
  assert.equal(detail.accountDeleted, false);
  assert.equal(detail.blockReason, 'Dispatcher safety review');
  assert.equal(detail.isOnline, false);
  assert.equal(detail.hasActiveTrip, true);
  assert.equal(detail.user.balance.amount, '470');
  const orders = (await request('/admin/orders?status=accepted', adminToken)).data.items;
  assert.equal(orders.find((item: { id: string }) => item.id === job.id).status, 'STARTED');
  assert.equal((await request(`/admin/drivers/${driver.id}/unblock`, adminToken, {})).status, 200);
  const fresh = await request('/auth/login', '', { phone: driver.user.phone, password, deviceId: 'after-temporary-block' });
  assert.equal(fresh.status, 200);
  assert.equal((await request('/orders/current', fresh.data.accessToken)).data.id, job.id);
});

test('a permanently deleted phone can apply again without recovering the old balance or history', async () => {
  const phone = '+99361999133';
  const created = await request('/admin/drivers', adminToken, { phone, fullName: 'Old deleted identity', password });
  const oldId = created.data.id;
  assert.equal((await request(`/admin/drivers/${oldId}/balance`, adminToken, { amount: 70, type: 'TOPUP' })).status, 200);
  const oldLogin = await request('/auth/login', '', { phone, password, deviceId: 'old-reapply-installation' });
  assert.equal((await startShift(oldLogin.data.accessToken)).status, 200);
  const completed = await order(12);
  for (const action of ['accept', 'waiting', 'start', 'complete']) assert.equal((await request(`/orders/${action}`, oldLogin.data.accessToken, { orderId: completed.id })).status, 200);
  const cancelled = await order(18);
  for (const action of ['accept', 'cancel']) assert.equal((await request(`/orders/${action}`, oldLogin.data.accessToken, { orderId: cancelled.id })).status, 200);
  const beforeToday = (await request('/admin/overview/today', adminToken)).data;
  const beforeTotals = (await request('/admin/overview', adminToken)).data;
  const beforeLedger = (await request(`/admin/drivers/${oldId}/history`, adminToken)).data;
  assert.equal(beforeTotals.completedTrips, 1);
  assert.equal(beforeTotals.completedTripValue, '12.00');
  assert.equal(beforeToday.cohort.created, 2);
  assert.equal(beforeToday.cohort.completed, 1);
  assert.equal(beforeToday.cohort.cancelled, 1);
  const deletion = await fetch(`${base}/admin/drivers/${oldId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
  assert.equal(deletion.status, 204);
  assert.equal((await request('/driver/profile', oldLogin.data.accessToken)).status, 401);
  assert.equal((await request(`/admin/drivers/${oldId}/approve`, adminToken, {})).status, 409);
  assert.equal((await request(`/admin/drivers/${oldId}/unblock`, adminToken, {})).status, 409);
  const registered = await request('/auth/register', '', { phone, fullName: 'New applicant identity', password: '654321' });
  assert.equal(registered.status, 201);
  const newId = registered.data.user.driver.id;
  assert.notEqual(newId, oldId);
  assert.equal(registered.data.user.driver.status, 'PENDING');
  assert.equal((await request('/auth/login', '', { phone, password: '654321', deviceId: 'new-reapply-installation' })).status, 403);
  assert.equal((await request(`/admin/drivers/${newId}/approve`, adminToken, {})).status, 200);
  const fresh = await request('/auth/login', '', { phone, password: '654321', deviceId: 'new-reapply-installation' });
  assert.equal(fresh.status, 200);
  assert.equal((await request('/driver/balance', fresh.data.accessToken)).data.amount, '0');
  assert.equal((await request('/driver/history', fresh.data.accessToken)).data.transactions.total, 0);
  assert.equal((await request('/orders/current', fresh.data.accessToken)).data, null);
  const old = (await request(`/admin/drivers/${oldId}`, adminToken)).data;
  assert.equal(old.accountDeleted, true);
  assert.equal(old.user.phone, phone);
  assert.equal(old.user.fullName, 'Old deleted identity');
  assert.equal(old.user.balance.amount, '58');
  const afterLedger = (await request(`/admin/drivers/${oldId}/history`, adminToken)).data;
  assert.deepEqual(afterLedger.transactions, beforeLedger.transactions);
  assert.deepEqual(afterLedger.orders, beforeLedger.orders);
  assert.equal(afterLedger.driver.phone, phone);
  const afterToday = (await request('/admin/overview/today', adminToken)).data;
  assert.deepEqual(afterToday.cohort, beforeToday.cohort);
  assert.deepEqual(afterToday.acceptance, beforeToday.acceptance);
  const afterTotals = (await request('/admin/overview', adminToken)).data;
  assert.equal(afterTotals.completedTrips, 1);
  assert.equal(afterTotals.completedTripValue, '12.00');
  assert.equal(afterTotals.averageCompletedTripValue, '12.00');
  assert.equal(afterTotals.pricedCompletedTrips, beforeTotals.pricedCompletedTrips);
  assert.equal((await request('/admin/orders?status=completed', adminToken)).data.items[0].driverId, oldId);
  assert.equal((await request('/admin/orders?status=cancelled', adminToken)).data.items[0].driverId, oldId);
  assert.equal(JSON.stringify((await request('/admin/orders?status=all', adminToken)).data).includes('deleted:'), false);
  assert.equal((await request('/driver/profile', oldLogin.data.accessToken)).status, 401, 'new application never revives old sessions');
});

test('reading chat while FCM delivery is in flight still promptly removes the delivered native notification', async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sending = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  await withFakeFcm(async sent => {
    const driver = (await request('/driver/profile', driverToken)).data;
    const registration = await request('/driver/notifications/registration', driverToken, { token: 'synthetic-inflight-read-token', enabled: true });
    const message = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Read during delayed transport' });
    try {
      await Promise.race([sending, new Promise((_, reject) => setTimeout(() => reject(new Error('FCM transport did not start')), 6000))]);
      assert.equal((await request('/driver/messages/read', driverToken, { throughMessageId: message.data.id })).status, 204);
      release();
      const deadline = Date.now() + 2500;
      while (sent.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      const eventId = `chat:${message.data.id}`;
      assert.deepEqual(sent.map(row => row.data.eventId), [eventId, eventId]);
      assert.equal((await request('/native-notifications/event', registration.data.notificationToken, { eventId })).data.event, null);
    } finally { release(); }
  }, async () => {
    if (!first) return;
    first = false;
    started();
    await gate;
  });
});

test("global sequential order numbers are stable across concurrent creation, queues, active trips and wallet history", async () => {
  await socket(adminToken);
  const created = await Promise.all(Array.from({ length: 12 }, () => order()));
  const numbers = created.map((item) => item.orderNumber);
  assert.equal(new Set(numbers).size, 12);
  assert.ok(numbers.every((number) => Number.isInteger(number) && number > 0));
  const highest = Math.max(...numbers);
  await prisma.order.delete({
    where: { id: created.find((item) => item.orderNumber === highest).id },
  });
  const next = await order();
  assert.equal(next.orderNumber, highest + 1);
  const available = await request(
    `/orders/available?districtId=${regionId}`,
    driverToken,
  );
  assert.equal(
    available.data.find((item: { id: string }) => item.id === next.id)
      ?.orderNumber,
    next.orderNumber,
  );
  const accepted = await request("/orders/accept", driverToken, {
    orderId: next.id,
  });
  assert.equal(accepted.data.orderNumber, next.orderNumber);
  const current = await request("/orders/current", driverToken);
  assert.equal(current.data.orderNumber, next.orderNumber);
  const found = await request(`/admin/orders?orderNumber=${next.orderNumber}`, adminToken);
  assert.equal(found.data.total, 1);
  assert.equal(found.data.items[0].id, next.id);
  for (const action of ["waiting", "start"]) assert.equal((await request(`/orders/${action}`, driverToken, { orderId: next.id })).status, 200);
  const history = await request("/driver/history", driverToken);
  assert.equal(
    history.data.orders.items.find(
      (item: { id: string }) => item.id === next.id,
    )?.orderNumber,
    next.orderNumber,
  );
  assert.equal(
    history.data.orders.items.some((item: object) => "clientPhone" in item),
    false,
  );
  assert.ok(
    history.data.transactions.items.some(
      (item: { note: string }) =>
        item.note ===
        `Заказ #${next.orderNumber}: цена поездки списана при начале`,
    ),
  );
});

test("dispatcher phone filters normalize formatted values, combine independently and match archived driver phones exactly", async () => {
  const profile = (await request("/driver/profile", driverToken)).data;
  const own = await prisma.order.create({
    data: {
      districtId: regionId,
      driverId: profile.id,
      status: "COMPLETED",
      pickupLat: 37.96,
      pickupLng: 58.32,
      clientPhone: "+99365111111",
      priceEstimated: 25,
    },
  });
  await prisma.order.create({
    data: {
      districtId: regionId,
      status: "COMPLETED",
      pickupLat: 37.96,
      pickupLng: 58.32,
      clientPhone: "+99365222222",
      priceEstimated: 25,
    },
  });
  const customer = await request(
    "/admin/orders?customerPhone=%2B993%2065-11-11-11",
    adminToken,
  );
  assert.equal(customer.status, 200);
  assert.deepEqual(
    customer.data.items.map((item: { id: string }) => item.id),
    [own.id],
  );
  const driver = await request(
    "/admin/orders?driverPhone=%2B993%2060-00-01-01",
    adminToken,
  );
  assert.equal(driver.status, 200);
  assert.deepEqual(
    driver.data.items.map((item: { id: string }) => item.id),
    [own.id],
  );
  assert.equal(
    (
      await request(
        "/admin/orders?customerPhone=%2B99365222222&driverPhone=%2B99360000101",
        adminToken,
      )
    ).data.total,
    0,
  );
  assert.equal(
    (await request("/admin/orders?driverPhone=60000101", adminToken)).status,
    400,
  );
  await prisma.user.update({
    where: { id: profile.userId },
    data: { archivedPhone: "+99360000101", phone: `deleted:${profile.userId}` },
  });
  try {
    const archived = await request(
      "/admin/orders?driverPhone=%2B99360000101",
      adminToken,
    );
    assert.equal(archived.status, 200);
    assert.deepEqual(
      archived.data.items.map((item: { id: string }) => item.id),
      [own.id],
    );
  } finally {
    await prisma.user.update({ where: { id: profile.userId }, data: { phone: "+99360000101", archivedPhone: null } });
  }
});


test('order-number migration backfills chronology, preserves UUID relations and continues without reuse', async () => {
  const schema = `order_migration_${randomUUID().replaceAll('-', '')}`;
  const sql = readFileSync(join(process.cwd(), 'prisma/migrations/20261017130000_order_numbers/migration.sql'), 'utf8');
  await prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
    await tx.$executeRawUnsafe('CREATE TABLE orders (id TEXT PRIMARY KEY, created_at TIMESTAMP NOT NULL)');
    await tx.$executeRawUnsafe('CREATE TABLE transactions (order_id TEXT, note TEXT)');
    await tx.$executeRawUnsafe(`INSERT INTO orders VALUES ('00000000-0000-0000-0000-000000000003', '2026-01-02'), ('00000000-0000-0000-0000-000000000002', '2026-01-01'), ('00000000-0000-0000-0000-000000000001', '2026-01-01')`);
    await tx.$executeRawUnsafe(`INSERT INTO transactions VALUES ('00000000-0000-0000-0000-000000000001', 'Заказ #00000000-0000-0000-0000-000000000001: цена поездки списана при принятии')`);
    const statements = sql.replace(/--[^\n]*/g, '').replace(/\bBEGIN;|\bCOMMIT;/g, '').split(';').map(value => value.trim()).filter(Boolean);
    for (const statement of statements) await tx.$executeRawUnsafe(statement);
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; order_number: number }>>('SELECT id, order_number FROM orders ORDER BY order_number');
    assert.deepEqual(rows, [
      { id: '00000000-0000-0000-0000-000000000001', order_number: 1 },
      { id: '00000000-0000-0000-0000-000000000002', order_number: 2 },
      { id: '00000000-0000-0000-0000-000000000003', order_number: 3 },
    ]);
    assert.deepEqual(await tx.$queryRawUnsafe('SELECT order_id, note FROM transactions'), [{ order_id: '00000000-0000-0000-0000-000000000001', note: 'Заказ #1: цена поездки списана при принятии' }]);
    await tx.$executeRawUnsafe("DELETE FROM orders WHERE order_number = 3");
    await tx.$executeRawUnsafe("INSERT INTO orders (id, created_at) VALUES ('after-delete', NOW())");
    assert.deepEqual(await tx.$queryRawUnsafe("SELECT order_number FROM orders WHERE id = 'after-delete'"), [{ order_number: 4 }]);
    await tx.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  });
});

test('release 1.20 holds the quote at accept, preserves it on arrival and captures it exactly once on start', async () => {
  const profile = (await request('/driver/profile', driverToken)).data;
  const created = await order(40);
  const admin = await socket(adminToken);
  const money: any[] = [];
  admin.on('balance:updated', payload => money.push(payload));
  assert.equal((await request('/orders/accept', driverToken, { orderId: created.id })).status, 200);
  const held = (await request(`/admin/drivers/${profile.id}`, adminToken)).data.user.balance;
  assert.equal(held.amount, '500');
  assert.equal(held.total, '500');
  assert.equal(held.held, '40');
  assert.equal(held.available, '460');
  assert.deepEqual((await request(`/admin/drivers/${profile.id}/history`, adminToken)).data.transactions.items, []);
  assert.equal((await request('/orders/waiting', driverToken, { orderId: created.id })).status, 200);
  assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
  // Metadata cannot change the accepted quote.
  await prisma.order.update({ where: { id: created.id }, data: { priceEstimated: 99 } });
  const starts = await Promise.all([1, 2].map(() => request('/orders/start', driverToken, { orderId: created.id })));
  assert.deepEqual(starts.map(r => r.status).sort(), [200, 409]);
  const captured = (await request(`/admin/drivers/${profile.id}`, adminToken)).data.user.balance;
  assert.equal(captured.amount, '460');
  assert.equal(captured.held, '0');
  assert.equal(captured.available, '460');
  const payments = (await request(`/admin/drivers/${profile.id}/history`, adminToken)).data.transactions.items;
  assert.equal(payments.length, 1);
  assert.equal(payments[0].type, 'PAYMENT');
  assert.equal(payments[0].amount, '-40');
  assert.equal((await request('/orders/complete', driverToken, { orderId: created.id })).data.priceFinal, '40');
  assert.equal(money.filter(e => e.reason === 'PAYMENT').length, 1);
  assert.equal(money.some(e => e.reason === 'HOLD' && e.amount === '500'), true);
});

test('held funds survive rejected reductions and an exact available withdrawal, then capture safely', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  const job = await order(40);
  assert.equal((await request('/orders/accept', driverToken, { orderId: job.id })).status, 200);
  for (const type of ['WITHDRAWAL', 'ADJUSTMENT']) {
    const denied = await request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: -461, type });
    assert.equal(denied.status, 400);
  }
  const exact = await request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: -460, type: 'WITHDRAWAL' });
  assert.equal(exact.status, 200);
  assert.equal(exact.data.balance.total, '40');
  assert.equal(exact.data.balance.held, '40');
  assert.equal(exact.data.balance.available, '0');
  for (const action of ['waiting', 'start']) assert.equal((await request(`/orders/${action}`, driverToken, { orderId: job.id })).status, 200);
  const balance = (await request(`/admin/drivers/${driver.id}`, adminToken)).data.user.balance;
  assert.equal(balance.total, '0');
  assert.equal(balance.held, '0');
  assert.equal(balance.available, '0');
  assert.deepEqual((await request('/driver/history', driverToken)).data.transactions.items.map((row: any) => row.type).sort(), ['PAYMENT', 'WITHDRAWAL']);
});

test('acceptance racing an admin reduction either reserves funds or rejects without an uncovered hold', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  for (const type of ['WITHDRAWAL', 'ADJUSTMENT']) {
    for (let round = 0; round < 6; round++) {
      const job = await order(40);
      const results = await Promise.all([
        request('/orders/accept', driverToken, { orderId: job.id }),
        request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: -480, type })
      ]);
      const wallet = (await request(`/admin/drivers/${driver.id}`, adminToken)).data.user.balance;
      if (results[0].status === 200) {
        assert.equal(results[1].status, 400);
        assert.deepEqual([wallet.total, wallet.held, wallet.available], ['500', '40', '460']);
        assert.equal((await request('/orders/cancel', driverToken, { orderId: job.id })).status, 200);
      } else {
        assert.equal(results[0].status, 403);
        assert.equal(results[1].status, 200);
        assert.deepEqual([wallet.total, wallet.held, wallet.available], ['20', '0', '20']);
        assert.equal((await request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 480, type: 'TOPUP' })).status, 200);
        assert.equal((await request(`/admin/orders/${job.id}/cancel`, adminToken, {})).status, 200);
      }
    }
  }
});

test('arrival racing driver cancel leaves either a retained WAITING hold or one actionable cancellation', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  for (let round = 0; round < 12; round++) {
    const job = await order(40);
    const body = { orderId: job.id };
    assert.equal((await request('/orders/accept', driverToken, body)).status, 200);
    const results = await Promise.all([request('/orders/waiting', driverToken, body), request('/orders/cancel', driverToken, body)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const wallet = (await request(`/admin/drivers/${driver.id}`, adminToken)).data.user.balance;
    assert.equal(wallet.total, '500');
    if (results[0].status === 200) {
      assert.equal(wallet.held, '40');
      assert.equal((await request('/orders/current', driverToken)).data.status, 'WAITING');
      assert.equal((await request(`/admin/orders/${job.id}/cancel`, adminToken, {})).status, 200);
    } else {
      assert.equal(wallet.held, '0');
      assert.equal((await request('/orders/current', driverToken)).data, null);
      assert.equal(results[1].data.cancellationReviewRequired, true);
    }
  }
  assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 0);
});

test('start racing dispatcher cancel commits only a capture or hold release and never a refund', async () => {
  const driver = (await request('/driver/profile', driverToken)).data;
  for (let round = 0; round < 12; round++) {
    const job = await order(40);
    const body = { orderId: job.id };
    for (const action of ['accept', 'waiting']) assert.equal((await request(`/orders/${action}`, driverToken, body)).status, 200);
    const results = await Promise.all([request('/orders/start', driverToken, body), request(`/admin/orders/${job.id}/cancel`, adminToken, {})]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const wallet = (await request(`/admin/drivers/${driver.id}`, adminToken)).data.user.balance;
    const entries = (await request('/driver/history?limit=100', driverToken)).data.transactions.items.filter((row: any) => row.orderId === job.id);
    assert.equal(wallet.held, '0');
    if (results[0].status === 200) {
      assert.equal(wallet.total, '460');
      assert.deepEqual(entries.map((row: any) => [row.type, row.amount]), [['PAYMENT', '-40']]);
      assert.equal((await request('/orders/complete', driverToken, body)).status, 200);
      assert.equal((await request(`/admin/drivers/${driver.id}/balance`, adminToken, { amount: 40, type: 'TOPUP' })).status, 200);
    } else {
      assert.equal(wallet.total, '500');
      assert.deepEqual(entries, []);
    }
  }
});

test('driver cancellation recovery is durable, sorted before pagination, and final cancellation removes all actions', async () => {
  const admin = await socket(adminToken);
  const driver = (await request('/driver/profile', driverToken)).data;
  const actionable: any[] = [];
  for (let index = 0; index < 2; index++) {
    const job = await order(40);
    assert.equal((await request('/orders/accept', driverToken, { orderId: job.id })).status, 200);
    const banner = nextSocketEvent<any>(admin, 'order:cancelled');
    const cancellation = await request('/orders/cancel', driverToken, { orderId: job.id });
    assert.equal(cancellation.status, 200);
    const event = await banner;
    assert.equal(event.orderNumber, job.orderNumber);
    assert.equal(event.driverId, driver.id);
    assert.equal(event.driver.user.fullName, driver.user.fullName);
    assert.equal(event.notificationEventId, job.notificationEventId);
    assert.equal(event.offerAttemptId, job.offerAttemptId);
    assert.equal(event.cancellationReviewRequired, true);
    actionable.push(job);
    await prisma.order.update({ where: { id: job.id }, data: { cancelledAt: new Date(`2020-01-0${index + 1}T00:00:00Z`) } });
  }
  for (let index = 0; index < 3; index++) {
    const terminal = await order();
    const result = await request(`/admin/orders/${terminal.id}/cancel`, adminToken, {});
    assert.equal(result.status, 200);
    assert.equal(result.data.cancellationReviewRequired, false);
    assert.deepEqual(result.data.resolutionActions, []);
  }
  const recovered = (await request('/admin/orders/cancellation-review?limit=1', adminToken)).data;
  assert.equal(recovered.total, 2);
  assert.equal(recovered.items[0].id, actionable[1].id);
  assert.deepEqual(recovered.items[0].resolutionActions, ['REOFFER', 'FINAL_CANCEL']);
  const firstPage = (await request('/admin/orders?status=cancelled&limit=1', adminToken)).data;
  const secondPage = (await request('/admin/orders?status=cancelled&limit=1&page=2', adminToken)).data;
  assert.equal(firstPage.items[0].id, actionable[1].id);
  assert.equal(secondPage.items[0].id, actionable[0].id);
  const results = await Promise.all([1, 2].map(() => request(`/admin/orders/${actionable[1].id}/final-cancel`, adminToken, {})));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(results.find(r => r.status === 200)!.data.resolutionActions, []);
  assert.equal((await request(`/admin/orders/${actionable[1].id}/reoffer`, adminToken, {})).status, 409);
  assert.equal((await request('/admin/orders/cancellation-review', adminToken)).data.total, 1);
  assert.equal((await request('/orders/available', driverToken)).data.length, 0);
  assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 0);
  assert.equal((await request('/admin/orders/cancellation-review', driverToken)).status, 403);
});

test('reoffer preserves order and assignment history but has a fresh canonical attempt across HTTP socket inbox native and FCM', async () => {
  await withFakeFcm(async sent => {
    const driver = (await request('/driver/profile', driverToken)).data;
    const recipient = await socket(driverToken);
    const registered = await request('/driver/notifications/registration', driverToken, { token: 'synthetic-reoffer-token', enabled: true });
    const original = await order(40);
    const originalInbox = (await request('/driver/notifications/inbox', driverToken)).data;
    assert.equal(originalInbox.events[0].id, original.notificationEventId);
    assert.equal(originalInbox.events[0].order.clientPhone, undefined);
    assert.equal(originalInbox.events[0].order.orderNumber, original.orderNumber);
    assert.ok(originalInbox.serverTime);
    assert.equal((await request('/orders/accept', driverToken, { orderId: original.id })).status, 200);
    assert.equal((await request('/orders/cancel', driverToken, { orderId: original.id })).status, 200);
    const popup = nextSocketEvent<any>(recipient, 'order:new');
    const results = await Promise.all([1, 2].map(() => request(`/admin/orders/${original.id}/reoffer`, adminToken, {})));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const reopened = results.find(r => r.status === 200)!.data;
    assert.equal(reopened.id, original.id);
    assert.equal(reopened.orderNumber, original.orderNumber);
    assert.equal(reopened.districtId, original.districtId);
    assert.equal(reopened.status, 'NEW');
    assert.equal(reopened.driverId, null);
    assert.equal(reopened.acceptedAt, null);
    assert.equal(reopened.arrivedAt, null);
    assert.equal(reopened.cancelledAt, null);
    assert.notEqual(reopened.offerAttemptId, original.offerAttemptId);
    assert.notEqual(reopened.notificationEventId, original.notificationEventId);
    assert.ok(Date.parse(reopened.expiresAt) - Date.parse(reopened.serverTime) <= 20_000);
    assert.ok(Date.parse(reopened.expiresAt) - Date.parse(reopened.serverTime) > 18_000);
    assert.equal((await popup).notificationEventId, reopened.notificationEventId);
    const inbox = (await request('/driver/notifications/inbox', driverToken)).data;
    assert.deepEqual(inbox.events.map((event: any) => event.id), [reopened.notificationEventId]);
    const old = await request('/native-notifications/event', registered.data.notificationToken, { eventId: original.notificationEventId });
    assert.equal(old.data.event, null);
    const fresh = await request('/native-notifications/event', registered.data.notificationToken, { eventId: reopened.notificationEventId });
    assert.equal(fresh.data.event.id, reopened.notificationEventId);
    assert.equal(fresh.data.event.offerAttemptId, reopened.offerAttemptId);
    assert.equal(fresh.data.event.expiresAt, reopened.expiresAt);
    assert.ok(fresh.data.event.serverTime);
    // Old acknowledgements and invalidation must never acknowledge the new attempt.
    assert.equal((await request('/driver/notifications/ack', driverToken, { eventId: original.notificationEventId })).status, 204);
    await new Promise(resolve => setTimeout(resolve, 4200));
    assert.ok(sent.some(row => row.data.eventId === reopened.notificationEventId));
    assert.equal((await request('/orders/available', driverToken)).data[0].notificationEventId, reopened.notificationEventId);
    const history = (await request(`/admin/orders?orderNumber=${original.orderNumber}`, adminToken)).data.items[0];
    assert.equal(history.assignments.length, 1);
    assert.equal(history.assignments[0].driverId, driver.id);
    assert.equal(history.assignments[0].quotedAmount, '40');
    assert.equal(history.assignments[0].endAction, 'DRIVER_CANCELLED');
    const taken = nextSocketEvent<any>(recipient, 'order:taken');
    // The former driver remains eligible and the next assignment is distinct.
    assert.equal((await request('/orders/accept', driverToken, { orderId: original.id })).status, 200);
    assert.equal((await taken).notificationEventId, reopened.notificationEventId);
    assert.deepEqual((await request('/driver/notifications/inbox', driverToken)).data.events, []);
    const full = (await request(`/admin/orders?orderNumber=${original.orderNumber}`, adminToken)).data.items[0];
    assert.equal(full.assignments.length, 2);
    assert.deepEqual(full.assignments.map((a: any) => a.fundingState).sort(), ['HELD', 'RELEASED']);
    assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 0);
  });
});

for (const state of ['ACCEPTED', 'WAITING', 'STARTED'] as const) {
  test(`legacy already-paid ${state} trip is not held or charged again after upgrade`, async () => {
    const driver = (await request('/driver/profile', driverToken)).data;
    const job = await order(99);
    // Explicit pre-upgrade fixture: 30 was paid at acceptance, quote metadata
    // later changed. No new assignment row exists in the old schema.
    await prisma.order.update({ where: { id: job.id }, data: { status: state, driverId: driver.id, acceptedAt: new Date(), arrivedAt: state === 'ACCEPTED' ? null : new Date(), startedAt: state === 'STARTED' ? new Date() : null } });
    await prisma.driver.update({ where: { id: driver.id }, data: { isAvailable: false } });
    const wallet = await prisma.balance.update({ where: { userId: driver.userId }, data: { amount: 470 } });
    await prisma.transaction.create({ data: { balanceId: wallet.id, orderId: job.id, type: 'PAYMENT', amount: -30, balanceAfter: 470 } });
    assert.equal((await request(`/admin/drivers/${driver.id}`, adminToken)).data.user.balance.held, '0');
    if (state === 'ACCEPTED') {
      assert.equal((await request('/orders/cancel', driverToken, { orderId: job.id })).status, 200);
      assert.equal((await request('/driver/balance', driverToken)).data.amount, '500');
      assert.equal((await request('/orders/cancel', driverToken, { orderId: job.id })).status, 409);
      const entries = (await request('/driver/history', driverToken)).data.transactions.items;
      assert.deepEqual(entries.map((row: any) => [row.type, row.amount]).sort(), [['PAYMENT', '-30'], ['REFUND', '30']]);
      assert.equal((await request(`/admin/orders/${job.id}/reoffer`, adminToken, {})).status, 200);
      const row = (await request(`/admin/orders?orderNumber=${job.orderNumber}`, adminToken)).data.items[0];
      assert.equal(row.assignments[0].quotedAmount, '30');
      assert.equal(row.assignments[0].driverId, driver.id);
    } else {
      if (state === 'WAITING') assert.equal((await request('/orders/start', driverToken, { orderId: job.id })).status, 200);
      assert.equal((await request('/orders/complete', driverToken, { orderId: job.id })).status, 200);
      assert.equal((await request('/driver/balance', driverToken)).data.amount, '470');
      assert.equal((await request('/driver/history', driverToken)).data.transactions.total, 1);
    }
  });
}

test('broadcast history and merged conversations exclude private replies and broadcasts predating account creation', async () => {
  await prisma.message.deleteMany();
  await prisma.driver.updateMany({ data: { lastChatReadAt: null, lastChatReadMessageId: null } });
  const driver = (await request('/driver/profile', driverToken)).data;
  const other = (await request('/driver/profile', otherToken)).data;
  const admin = await prisma.user.findFirstOrThrow({ where: { role: 'ADMIN' } });
  const createdAt = new Date('2026-10-18T12:00:00Z');
  const oldCreatedAt = (await prisma.user.findUniqueOrThrow({ where: { id: driver.userId } })).createdAt;
  await prisma.user.update({ where: { id: driver.userId }, data: { createdAt } });
  const old = await prisma.message.create({ data: { senderId: admin.id, isBroadcast: true, body: 'Before registration', sentAt: new Date('2026-10-18T11:59:59Z') } });
  const boundary = await prisma.message.create({ data: { senderId: admin.id, isBroadcast: true, body: 'At registration', sentAt: createdAt } });
  try {
    const broadcast = await request('/admin/messages', adminToken, { broadcast: true, body: 'Dispatch broadcast' });
    const ownReply = await request('/driver/messages', driverToken, { body: 'Private driver reply' });
    const foreignReply = await request('/driver/messages', otherToken, { body: 'Other private reply' });
    const ownAdmin = await request('/admin/messages', adminToken, { driverId: driver.id, body: 'Private dispatcher reply' });
    const foreignAdmin = await request('/admin/messages', adminToken, { driverId: other.id, body: 'Other dispatcher reply' });
    const history = (await request('/admin/messages/broadcasts?limit=100', adminToken)).data;
    assert.deepEqual(history.items.map((m: any) => m.id), [old.id, boundary.id, broadcast.data.id]);
    assert.equal(history.total, 3);
    const merged = (await request(`/admin/drivers/${driver.id}/messages?limit=100`, adminToken)).data;
    assert.deepEqual(merged.items.map((m: any) => m.id), [boundary.id, broadcast.data.id, ownReply.data.id, ownAdmin.data.id]);
    assert.equal(merged.items.filter((m: any) => m.isBroadcast).length, 2);
    const own = (await request('/driver/messages?limit=100', driverToken)).data;
    assert.deepEqual(own.items.map((m: any) => m.id), merged.items.map((m: any) => m.id));
    assert.equal(own.unread, 3);
    assert.equal((await request('/driver/messages/read', driverToken, { throughMessageId: old.id })).status, 400);
    const otherView = (await request('/driver/messages?limit=100', otherToken)).data;
    assert.equal(otherView.items.some((m: any) => [ownReply.data.id, ownAdmin.data.id].includes(m.id)), false);
    assert.equal(own.items.some((m: any) => [foreignReply.data.id, foreignAdmin.data.id].includes(m.id)), false);
    assert.equal((await request('/admin/messages/broadcasts', driverToken)).status, 403);
    const paged = (await request('/admin/messages/broadcasts?limit=1', adminToken)).data;
    assert.equal(paged.items[0].id, broadcast.data.id);
    const older = (await request(`/admin/messages/broadcasts?limit=2&beforeMessageId=${broadcast.data.id}`, adminToken)).data;
    assert.deepEqual(older.items.map((m: any) => m.id), [old.id, boundary.id]);
    const installation = await request('/driver/notifications/registration', driverToken, { token: null });
    assert.equal((await request('/native-notifications/event', installation.data.notificationToken, { eventId: `chat:${old.id}` })).data.event, null);
  } finally {
    await prisma.user.update({ where: { id: driver.userId }, data: { createdAt: oldCreatedAt } });
  }
});

test('driver cancellation reaches every signed-in driver socket with its exact attempt identity', async () => {
  const driver = await socket(driverToken);
  const otherSession = await request('/auth/login', '', { phone: '+99360000101', password, deviceId: 'synthetic-cancel-observer' });
  const observer = await socket(otherSession.data.accessToken);
  await new Promise(resolve => setTimeout(resolve, 50));
  const job = await order(40);
  assert.equal((await request('/orders/accept', driverToken, { orderId: job.id })).status, 200);
  const [cancelled, ownEvent, observerEvent] = await Promise.all([
    request('/orders/cancel', driverToken, { orderId: job.id }),
    nextSocketEvent<any>(driver, 'order:cancelled', 1200),
    nextSocketEvent<any>(observer, 'order:cancelled', 1200)
  ]);
  assert.equal(cancelled.status, 200);
  for (const event of [ownEvent, observerEvent]) {
    assert.equal(event.id, job.id);
    assert.equal(event.orderNumber, job.orderNumber);
    assert.equal(event.offerAttemptId, job.offerAttemptId);
    assert.equal(event.notificationEventId, job.notificationEventId);
    assert.equal(event.status, 'CANCELLED');
  }
});
