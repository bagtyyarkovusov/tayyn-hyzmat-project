import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { resolve } from "node:path";
import app from "../dist/app";
import initSockets from "../dist/sockets";

const databaseName = new URL(process.env.DATABASE_URL!).pathname;
if (
  process.env.DISPOSABLE_DB_TEST !== "true" ||
  !/^\/(tayyn_test|address_[a-f0-9]+)$/.test(databaseName)
) {
  throw new Error("Use the disposable database test runner");
}
const prisma = new PrismaClient();
const server = createServer(app);
const sockets = initSockets(server);
let base = "",
  adminToken = "",
  driverToken = "",
  otherToken = "",
  driverId = "";
async function request(path: string, token = "", body?: unknown) {
  if (/^\/geo\/drivers\/[^/]+\/address$/.test(path) && body === undefined)
    body = { purpose: "refresh" };
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}
const originalFetch = globalThis.fetch;
let providerRequests: URL[] = [];
let providerHeaders: Headers[] = [];
let requiredReferer: string | null = null;
let providerComponents = [
  { kind: "street", name: "Synthetic street" },
  { kind: "house", name: "12" },
];
let providerMetadata: { kind?: string; precision?: string } = {};
let providerStatus = 200;
let providerHangs = false;
let providerPause = false;
let releaseProvider: (() => void) | undefined;
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://geocode-maps.yandex.ru")
    return originalFetch(input, init);
  providerRequests.push(url);
  const headers = new Headers(init?.headers);
  providerHeaders.push(headers);
  if (requiredReferer && headers.get("referer") !== requiredReferer)
    return new Response("", { status: 403 });
  if (providerPause)
    await new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
  if (providerHangs)
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) reject(signal.reason);
      else
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
    });
  if (providerStatus !== 200)
    return new Response("", { status: providerStatus });
  return Response.json({
    response: {
      GeoObjectCollection: {
        featureMember: [
          {
            GeoObject: {
              metaDataProperty: {
                GeocoderMetaData: {
                  ...providerMetadata,
                  Address: { Components: providerComponents },
                },
              },
            },
          },
        ],
      },
    },
  });
};
beforeEach(async () => {
  providerRequests = [];
  providerHeaders = [];
  requiredReferer = null;
  providerComponents = [
    { kind: "street", name: "Synthetic street" },
    { kind: "house", name: "12" },
  ];
  providerMetadata = {};
  providerStatus = 200;
  providerHangs = false;
  providerPause = false;
  releaseProvider = undefined;
  delete process.env.YANDEX_GEOCODER_CACHE_SECONDS;
  delete process.env.YANDEX_GEOCODER_API_KEY;
  delete process.env.YANDEX_GEOCODER_REFERER;
  await prisma.driverAddressState.deleteMany();
  await prisma.driverDevice.updateMany({
    data: { addressConvenienceAt: null },
  });
  await prisma.geocoderBudget.deleteMany();
  await prisma.driver.updateMany({
    where: { user: { phone: { in: ["+99360000201", "+99360000202"] } } },
    data: {
      isOnline: true,
      shiftDeviceId: "synthetic-address-device",
      lastLocationAt: new Date(),
    },
  });
  if (driverId)
    await prisma.driver.update({
      where: { id: driverId },
      data: { lastLat: 37.96, lastLng: 58.32, lastLocationAt: new Date() },
    });
});
before(async () => {
  delete process.env.YANDEX_GEOCODER_API_KEY;
  const passwordHash = await bcrypt.hash("SyntheticAddress123!", 4);
  for (const [phone, role] of [
    ["+99360000200", "ADMIN"],
    ["+99360000201", "DRIVER"],
    ["+99360000202", "DRIVER"],
  ] as const) {
    const user = await prisma.user.create({
      data: {
        phone,
        fullName: "Synthetic address test",
        role,
        passwordHash,
        balance: { create: { amount: 500 } },
        ...(role === "ADMIN"
          ? { admin: { create: { permissionLevel: "SUPER" } } }
          : {
              driver: {
                create: {
                  status: "APPROVED",
                  lastLat: 37.96,
                  lastLng: 58.32,
                  lastLocationAt: new Date(),
                },
              },
            }),
      },
      include: { driver: true },
    });
    if (phone === "+99360000201") driverId = user.driver!.id;
  }
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  const login = async (phone: string) =>
    (
      await request("/auth/login", "", {
        phone,
        password: "SyntheticAddress123!",
        deviceId: "synthetic-address-device",
      })
    ).data.accessToken as string;
  adminToken = await login("+99360000200");
  driverToken = await login("+99360000201");
  otherToken = await login("+99360000202");
});
after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => sockets.close(() => resolve()));
  await prisma.$disconnect();
  await require("../dist/lib/prisma").$disconnect();
});
test("address is optional without a private key and only its driver may request that driver location", async () => {
  const path = `/geo/drivers/${driverId}/address`;
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, otherToken)).status, 403);
  const own = await request(path, driverToken);
  assert.equal(own.status, 200);
  assert.equal(own.data.address, null);
  assert.deepEqual(own.data.position, { lat: 37.96, lng: 58.32 });
  assert.equal(own.data.reason, "unconfigured");
  assert.equal((await request(path, adminToken)).status, 403);
});

test("a foreground address request uses the private HTTP credential and server GPS with longitude first", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  const result = await request(`/geo/drivers/${driverId}/address`, driverToken);
  assert.equal(result.status, 200);
  assert.equal(result.data.address, "Synthetic street, 12");
  assert.equal(providerRequests.length, 1);
  assert.equal(providerHeaders[0].get("referer"), null);
  assert.equal(providerRequests[0].searchParams.get("geocode"), "58.32,37.96");
  assert.equal(
    providerRequests[0].searchParams.get("apikey"),
    "synthetic-private-geocoder",
  );
  assert.ok(
    !JSON.stringify(result.data).includes("synthetic-private-geocoder"),
  );
});

// Yandex Components are ordered from broadest to most specific.
const ashgabatComponents = [
  { kind: "country", name: "Туркменистан" },
  { kind: "locality", name: "Ашхабад" },
];
for (const example of [
  {
    name: "a precise house in Parahat without a street",
    position: { lat: 37.8968707, lng: 58.4064495 },
    components: [
      ...ashgabatComponents,
      { kind: "district", name: "микрорайон Парахат 7/3" },
      { kind: "house", name: "14" },
    ],
    metadata: { kind: "house", precision: "exact" },
    address: "микрорайон Парахат 7/3, 14",
  },
  {
    name: "the Kyoshi quarter without a street or house",
    position: { lat: 37.9601, lng: 58.3261 },
    components: [
      ...ashgabatComponents,
      { kind: "district", name: "квартал Кёши" },
    ],
    address: "квартал Кёши",
  },
  {
    name: "a street and house ahead of its district",
    components: [
      ...ashgabatComponents,
      { kind: "district", name: "квартал Кёши" },
      { kind: "street", name: "Дворцовая улица" },
      { kind: "house", name: "12" },
    ],
    address: "Дворцовая улица, 12",
  },
  {
    name: "a street without a house ahead of its district",
    components: [
      ...ashgabatComponents,
      { kind: "district", name: "квартал Кёши" },
      { kind: "street", name: "Дворцовая улица" },
    ],
    address: "Дворцовая улица",
  },
  {
    name: "the most specific district with a house",
    components: [
      ...ashgabatComponents,
      { kind: "district", name: "Багтыярлыкский этрап" },
      { kind: "district", name: "квартал Кёши" },
      { kind: "house", name: "14" },
    ],
    address: "квартал Кёши, 14",
  },
  {
    name: "the most specific district without a house",
    components: [
      ...ashgabatComponents,
      { kind: "district", name: "Багтыярлыкский этрап" },
      { kind: "district", name: "квартал Кёши" },
    ],
    address: "квартал Кёши",
  },
  {
    name: "no label for locality-only components",
    components: ashgabatComponents,
    address: null,
  },
  {
    name: "no label for country and province alone",
    components: [
      { kind: "country", name: "Туркменистан" },
      { kind: "province", name: "Ахалский велаят" },
    ],
    address: null,
  },
  {
    name: "no label for a house without a street or district",
    components: [...ashgabatComponents, { kind: "house", name: "14" }],
    address: null,
  },
]) {
  test(`driver address returns ${example.name}`, async () => {
    process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
    process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
    process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
    providerComponents = example.components;
    providerMetadata = example.metadata || {};
    const position = example.position || { lat: 37.96, lng: 58.32 };
    await prisma.driver.update({
      where: { id: driverId },
      data: {
        lastLat: position.lat,
        lastLng: position.lng,
        lastLocationAt: new Date(),
      },
    });
    const result = await request(
      `/geo/drivers/${driverId}/address`,
      driverToken,
    );
    assert.equal(result.status, 200);
    assert.equal(result.data.address, example.address);
    assert.deepEqual(result.data.position, position);
    assert.equal(result.data.reason, "resolved");
  });
}

test("off-shift and non-owning phones never fetch an address for shared driver GPS", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  const path = `/geo/drivers/${driverId}/address`;
  await prisma.driver.update({
    where: { id: driverId },
    data: { isOnline: false, shiftDeviceId: null },
  });
  for (const token of [driverToken]) {
    const result = await request(path, token);
    assert.equal(result.status, 200);
    assert.equal(result.data.address, null);
    assert.equal(result.data.position, null);
    assert.equal(result.data.reason, "off-shift");
  }
  assert.equal(providerRequests.length, 0);
  await prisma.driver.update({
    where: { id: driverId },
    data: { isOnline: true, shiftDeviceId: "another-phone" },
  });
  const spectator = await request(path, driverToken);
  assert.equal(spectator.status, 200);
  assert.equal(spectator.data.reason, "other-shift-device");
  assert.equal(spectator.data.position, null);
  assert.equal(providerRequests.length, 0);
  const dispatcher = await request(path, adminToken);
  assert.equal(dispatcher.status, 403);
  assert.equal(providerRequests.length, 0);
});

test("a domain-restricted geocoder resolves addresses with the configured HTTPS Referer origin", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  process.env.YANDEX_GEOCODER_REFERER = "https://dispatch.example";
  requiredReferer = "https://dispatch.example/";
  const result = await request(`/geo/drivers/${driverId}/address`, driverToken);
  assert.equal(result.status, 200);
  assert.equal(result.data.address, "Synthetic street, 12");
  assert.equal(result.data.reason, "resolved");
  assert.equal(providerHeaders[0].get("referer"), requiredReferer);
});

test("invalid geocoder Referer configuration falls back without calling the provider", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  for (const referer of [
    "http://dispatch.example",
    "https://user:password@dispatch.example",
    "https://@dispatch.example",
    "https://dispatch.example/path",
    "https://dispatch.example/?key=unwanted",
    "https://dispatch.example/#fragment",
    "https://dispatch.example?",
    "https://dispatch.example#",
    "https://dispatch.example/\r\nX-Injected: value",
    "https:dispatch.example",
    "https://dispatch.example\\path",
    "not-a-url",
  ]) {
    process.env.YANDEX_GEOCODER_REFERER = referer;
    const result = await request(
      `/geo/drivers/${driverId}/address`,
      driverToken,
    );
    assert.equal(result.status, 200);
    assert.equal(result.data.address, null);
    assert.equal(result.data.reason, "unconfigured");
    assert.deepEqual(result.data.position, { lat: 37.96, lng: 58.32 });
  }
  assert.equal(providerRequests.length, 0);
});

test("driver refreshes share the five-minute gate even after movement and concurrent requests", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  await request(`/geo/drivers/${driverId}/address`, driverToken);
  assert.equal(
    (await request("/driver/location", driverToken, { lat: 37.97, lng: 58.32 }))
      .status,
    200,
  );
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      request(`/geo/drivers/${driverId}/address`, driverToken),
    ),
  );
  assert.equal(providerRequests.length, 1);
  assert.ok(
    results.every(
      (result) => result.status === 200 && result.data.address === null,
    ),
  );
  assert.deepEqual(results[0].data.position, { lat: 37.97, lng: 58.32 });
});

test("switching the shift to another signed-in device keeps the driver cooldown", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  const path = `/geo/drivers/${driverId}/address`;
  assert.equal(
    (await request(path, driverToken)).data.address,
    "Synthetic street, 12",
  );
  const secondLogin = await request("/auth/login", "", {
    phone: "+99360000201",
    password: "SyntheticAddress123!",
    deviceId: "second-address-phone",
  });
  assert.equal(secondLogin.status, 200);
  // Fixture represents the later shift acquisition; only the public address
  // response and provider boundary establish the persisted quota behavior.
  await prisma.driver.update({
    where: { id: driverId },
    data: { shiftDeviceId: "second-address-phone" },
  });
  const limited = await request(path, secondLogin.data.accessToken);
  assert.equal(limited.status, 200);
  assert.equal(limited.data.reason, "limited");
  assert.ok(Date.parse(limited.data.retryAt) > Date.now());
  assert.equal(providerRequests.length, 1);
});

test("manual refresh works after five minutes without movement", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  const path = `/geo/drivers/${driverId}/address`;
  assert.equal(
    (await request(path, driverToken)).data.address,
    "Synthetic street, 12",
  );
  await prisma.driverAddressState.update({
    where: { driverId },
    data: { attemptedAt: new Date(Date.now() - 301_000) },
  });
  const refreshed = await request(path, driverToken);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.address, "Synthetic street, 12");
  assert.equal(providerRequests.length, 2);
});

test("the fleet stops at 80 percent of configured daily quota and retains the reserve under races", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "5";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  for (let index = 0; index < 3; index++) {
    await prisma.driverAddressState.deleteMany();
    await request(`/geo/drivers/${driverId}/address`, driverToken);
  }
  await prisma.driverAddressState.deleteMany();
  const other = await prisma.driver.findFirstOrThrow({
    where: { user: { phone: "+99360000202" } },
  });
  const responses = await Promise.all([
    request(`/geo/drivers/${driverId}/address`, driverToken),
    request(`/geo/drivers/${other.id}/address`, otherToken),
  ]);
  assert.equal(providerRequests.length, 4);
  assert.equal(
    responses.filter((result) => result.data.address !== null).length,
    1,
  );
  assert.equal(
    responses.filter((result) => result.data.reason === "budget-exhausted")
      .length,
    1,
  );
});

test("a provider 403 opens a fleet circuit breaker, consumes its attempt and never changes GPS eligibility", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "2";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  providerStatus = 403;
  const first = await request(`/geo/drivers/${driverId}/address`, driverToken);
  assert.equal(first.data.address, null);
  const other = await prisma.driver.findFirstOrThrow({
    where: { user: { phone: "+99360000202" } },
  });
  const second = await request(`/geo/drivers/${other.id}/address`, otherToken);
  assert.equal(second.data.reason, "provider-backoff");
  assert.equal(providerRequests.length, 1);
  await prisma.geocoderBudget.update({
    where: { provider: "yandex" },
    data: { blockedUntil: new Date(0) },
  });
  assert.equal(
    (await request(`/geo/drivers/${other.id}/address`, otherToken)).data.reason,
    "budget-exhausted",
  );
  assert.equal(providerRequests.length, 1);
  const location = await request("/driver/location", driverToken, {
    lat: 37.96,
    lng: 58.32,
  });
  assert.equal(location.status, 200);
  // A missing address never gates the independent online endpoint.
  await prisma.balance.upsert({
    where: {
      userId: (
        await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })
      ).userId,
    },
    create: {
      userId: (
        await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })
      ).userId,
      amount: 500,
    },
    update: { amount: 500 },
  });
  assert.equal(
    (
      await request("/driver/status", driverToken, {
        isOnline: true,
        position: { lat: 37.96, lng: 58.32, capturedAt: Date.now() },
      })
    ).status,
    200,
  );
});

test("contract-enabled short caching reuses the same source address for its driver without spending another attempt", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "5";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  process.env.YANDEX_GEOCODER_CACHE_SECONDS = "60";
  const path = `/geo/drivers/${driverId}/address`;
  assert.equal(
    (await request(path, driverToken)).data.address,
    "Synthetic street, 12",
  );
  assert.equal(
    (await request(path, driverToken)).data.address,
    "Synthetic street, 12",
  );
  assert.equal(providerRequests.length, 1);
  delete process.env.YANDEX_GEOCODER_CACHE_SECONDS;
});

test("a fresh API process shares the persisted driver limit and fleet budget", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "2";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  assert.equal(
    (await request(`/geo/drivers/${driverId}/address`, driverToken)).data
      .address,
    "Synthetic street, 12",
  );
  const { spawn } = await import("node:child_process");
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
    const original = globalThis.fetch;
    globalThis.fetch = (input,init) => {
      if (String(input).startsWith('https://geocode-maps.yandex.ru')) { process.stderr.write('UNEXPECTED_PROVIDER_CALL'); return Promise.resolve(Response.json({})); }
      return original(input,init);
    };
    const server = require('node:http').createServer(require('./dist/app'));
    server.listen(0,'127.0.0.1',()=>console.log('PORT='+server.address().port));
  `,
    ],
    {
      cwd: resolve(__dirname, ".."),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostics = "";
  child.stderr.on("data", (data) => {
    diagnostics += data.toString();
  });
  try {
    const [output] = await once(child.stdout, "data");
    const port = String(output).match(/PORT=(\d+)/)?.[1];
    assert.ok(port);
    const fresh = async (id: string, token: string) =>
      (
        await originalFetch(
          `http://127.0.0.1:${port}/geo/drivers/${id}/address`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ purpose: "refresh" }),
          },
        )
      ).json();
    assert.equal((await fresh(driverId, driverToken)).reason, "limited");
    const other = await prisma.driver.findFirstOrThrow({
      where: { user: { phone: "+99360000202" } },
    });
    assert.equal(
      (await fresh(other.id, otherToken)).reason,
      "budget-exhausted",
    );
    assert.ok(!diagnostics.includes("UNEXPECTED_PROVIDER_CALL"));
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

test("a new quota day replenishes only the fleet budget and does not bypass a driver gate", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "2";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  await request(`/geo/drivers/${driverId}/address`, driverToken);
  await prisma.geocoderBudget.update({
    where: { provider: "yandex" },
    data: { period: "2000-01-01" },
  });
  assert.equal(
    (await request(`/geo/drivers/${driverId}/address`, driverToken)).data
      .reason,
    "limited",
  );
  const other = await prisma.driver.findFirstOrThrow({
    where: { user: { phone: "+99360000202" } },
  });
  assert.equal(
    (await request(`/geo/drivers/${other.id}/address`, otherToken)).data
      .address,
    "Synthetic street, 12",
  );
  assert.equal(providerRequests.length, 2);
});

test("invalid configuration and stale GPS never call the provider, and arbitrary-coordinate lookup cannot bypass the fleet policy", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "Invalid/Zone";
  assert.equal(
    (await request(`/geo/drivers/${driverId}/address`, driverToken)).data
      .reason,
    "unconfigured",
  );
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  await prisma.driver.update({
    where: { id: driverId },
    data: { lastLocationAt: new Date(Date.now() - 61_000) },
  });
  const stale = await request(`/geo/drivers/${driverId}/address`, driverToken);
  assert.equal(stale.data.reason, "gps-unavailable");
  assert.equal(stale.data.position, null);
  assert.equal(
    (await request("/geo/reverse?lat=37.96&lng=58.32", driverToken)).status,
    403,
  );
  const legacy = await request("/geo/reverse?lat=37.96&lng=58.32", adminToken);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.data.address, null);
  assert.equal(
    (await request("/geo/reverse?lat=999&lng=58.32", adminToken)).status,
    400,
  );
  assert.equal(providerRequests.length, 0);
});

test("a hung provider times out and subsequent fleet demand falls back during backoff", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  providerHangs = true;
  const started = Date.now();
  const result = await request(`/geo/drivers/${driverId}/address`, driverToken);
  assert.equal(result.status, 200);
  assert.equal(result.data.address, null);
  assert.equal(result.data.reason, "provider-unavailable");
  assert.ok(Date.now() - started < 6000);
  const other = await prisma.driver.findFirstOrThrow({
    where: { user: { phone: "+99360000202" } },
  });
  assert.equal(
    (await request(`/geo/drivers/${other.id}/address`, otherToken)).data.reason,
    "provider-backoff",
  );
  assert.equal(providerRequests.length, 1);
});

test("licensed cache replies preserve source age and retention cannot exceed five minutes", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  process.env.YANDEX_GEOCODER_CACHE_SECONDS = "300";
  const initial = await request(
    `/geo/drivers/${driverId}/address`,
    driverToken,
  );
  assert.equal(initial.data.reason, "resolved");
  const sourceTime = new Date(Date.now() - 240_000);
  await prisma.driverAddressState.update({
    where: { driverId },
    data: { attemptedAt: sourceTime },
  });
  const cached = await request(`/geo/drivers/${driverId}/address`, driverToken);
  assert.equal(cached.data.reason, "cached");
  assert.equal(cached.data.resolvedAt, sourceTime.toISOString());
  assert.equal(providerRequests.length, 1);
  process.env.YANDEX_GEOCODER_CACHE_SECONDS = "301";
  assert.equal(
    (await request(`/geo/drivers/${driverId}/address`, driverToken)).data
      .reason,
    "unconfigured",
  );
  assert.equal(providerRequests.length, 1);
});

test("one off-shift lookup uses only the transient phone fix and never changes shared tracking", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  await prisma.driver.update({
    where: { id: driverId },
    data: { isOnline: false, shiftDeviceId: null },
  });
  const path = `/geo/drivers/${driverId}/address`;
  const before = (await request("/driver/profile", driverToken)).data;
  const body = {
    purpose: "off-shift",
    position: { lat: 37.99, lng: 58.36, capturedAt: Date.now() },
  };
  const first = await request(path, driverToken, body);
  assert.equal(first.status, 200);
  assert.equal(first.data.address, "Synthetic street, 12");
  assert.equal(first.data.convenienceConsumed, true);
  assert.deepEqual(first.data.position, { lat: 37.99, lng: 58.36 });
  const repeated = await request(path, driverToken, body);
  assert.equal(repeated.data.reason, "convenience-consumed");
  const after = (await request("/driver/profile", driverToken)).data;
  assert.equal(after.lastLat, before.lastLat);
  assert.equal(after.lastLng, before.lastLng);
  assert.equal(after.lastLocationAt, before.lastLocationAt);
  assert.equal(after.districtId, before.districtId);
  assert.equal(after.isOnline, false);
  assert.equal(providerRequests.length, 1);
});

test("only a successful explicit Online grants the single exception after off-shift lookup", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  await prisma.driver.update({
    where: { id: driverId },
    data: { isOnline: false, shiftDeviceId: null },
  });
  const path = `/geo/drivers/${driverId}/address`;
  const position = { lat: 37.96, lng: 58.32, capturedAt: Date.now() };
  assert.equal(
    (await request(path, driverToken, { purpose: "off-shift", position })).data
      .reason,
    "resolved",
  );
  assert.equal(
    (await request(path, driverToken, { purpose: "online" })).data.reason,
    "off-shift",
  );
  assert.equal(
    (await request("/driver/status", driverToken, { isOnline: true, position }))
      .status,
    200,
  );
  assert.equal(
    (await request(path, driverToken, { purpose: "online" })).data.reason,
    "resolved",
  );
  assert.equal(providerRequests.length, 2);
  await request("/driver/status", driverToken, { isOnline: false });
  await request("/driver/status", driverToken, {
    isOnline: true,
    position: { ...position, capturedAt: Date.now() },
  });
  assert.equal(
    (await request(path, driverToken, { purpose: "online" })).data.reason,
    "limited",
  );
  assert.equal(providerRequests.length, 2);
});

test("an off-shift lookup rejects stale or malformed positions before spending quota", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  await prisma.driver.update({
    where: { id: driverId },
    data: { isOnline: false, shiftDeviceId: null },
  });
  const path = `/geo/drivers/${driverId}/address`;
  for (const position of [
    undefined,
    { lat: 999, lng: 58.32, capturedAt: Date.now() },
    { lat: 37.96, lng: 58.32, capturedAt: Date.now() - 61_000 },
  ]) {
    assert.equal(
      (await request(path, driverToken, { purpose: "off-shift", position }))
        .status,
      400,
    );
  }
  assert.equal(providerRequests.length, 0);
});

test("another installation cannot spend a second convenience lookup inside the driver cooldown", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  await prisma.driver.update({
    where: { id: driverId },
    data: { isOnline: false, shiftDeviceId: null },
  });
  const path = `/geo/drivers/${driverId}/address`;
  const body = {
    purpose: "off-shift",
    position: { lat: 37.96, lng: 58.32, capturedAt: Date.now() },
  };
  assert.equal(
    (await request(path, driverToken, body)).data.reason,
    "resolved",
  );
  const login = await request("/auth/login", "", {
    phone: "+99360000201",
    password: "SyntheticAddress123!",
    deviceId: "another-convenience-phone",
  });
  const second = await request(path, login.data.accessToken, body);
  assert.equal(second.data.reason, "limited");
  assert.equal(second.data.convenienceConsumed, false);
  const relogin = await request("/auth/login", "", {
    phone: "+99360000201",
    password: "SyntheticAddress123!",
    deviceId: "synthetic-address-device",
  });
  assert.equal(
    (await request(path, relogin.data.accessToken, body)).data.reason,
    "convenience-consumed",
  );
  assert.equal(providerRequests.length, 1);
});

test("Online waits for an in-flight convenience provider call then uses its exception exactly once", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  await prisma.driver.update({
    where: { id: driverId },
    data: { isOnline: false, shiftDeviceId: null },
  });
  const path = `/geo/drivers/${driverId}/address`;
  providerPause = true;
  const position = { lat: 37.96, lng: 58.32, capturedAt: Date.now() };
  const initial = request(path, driverToken, {
    purpose: "off-shift",
    position,
  });
  try {
    for (let attempts = 0; !releaseProvider && attempts < 100; attempts++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(releaseProvider, "provider boundary should be in flight");
    assert.equal(
      (
        await request("/driver/status", driverToken, {
          isOnline: true,
          position,
        })
      ).status,
      200,
    );
    const pending = await request(path, driverToken, { purpose: "online" });
    assert.equal(pending.data.reason, "pending");
    assert.ok(Date.parse(pending.data.retryAt) > Date.now());
    assert.equal(providerRequests.length, 1);
  } finally {
    providerPause = false;
    releaseProvider?.();
    await initial;
  }
  assert.equal(
    (await request(path, driverToken, { purpose: "online" })).data.reason,
    "resolved",
  );
  assert.equal(
    (await request(path, driverToken, { purpose: "online" })).data.reason,
    "limited",
  );
  assert.equal(providerRequests.length, 2);
});

test("legacy GET is retired and declaring Online cannot bypass an existing shift cooldown", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  const path = `/geo/drivers/${driverId}/address`;
  const retired = await originalFetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${driverToken}` },
  });
  assert.equal(retired.status, 404);
  assert.equal((await request(path, driverToken)).data.reason, "resolved");
  assert.equal(
    (await request(path, driverToken, { purpose: "online" })).data.reason,
    "limited",
  );
  assert.equal(providerRequests.length, 1);
});

test("licensed cache keeps its original source point instead of reanchoring the address to later GPS", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  process.env.YANDEX_GEOCODER_CACHE_SECONDS = "300";
  const path = `/geo/drivers/${driverId}/address`;
  const initial = await request(path, driverToken);
  assert.equal(initial.data.reason, "resolved");
  assert.deepEqual(initial.data.position, { lat: 37.96, lng: 58.32 });
  // Roughly 100 m north can still reuse the label; its source must not move.
  assert.equal(
    (
      await request("/driver/location", driverToken, {
        lat: 37.9609,
        lng: 58.32,
      })
    ).status,
    200,
  );
  const nearby = await request(path, driverToken);
  assert.equal(nearby.data.reason, "cached");
  assert.equal(nearby.data.address, "Synthetic street, 12");
  assert.deepEqual(nearby.data.position, { lat: 37.96, lng: 58.32 });
  assert.equal(nearby.data.resolvedAt, initial.data.resolvedAt);
  // Roughly 167 m from the provider source must fall back to coordinates.
  assert.equal(
    (
      await request("/driver/location", driverToken, {
        lat: 37.9615,
        lng: 58.32,
      })
    ).status,
    200,
  );
  const moved = await request(path, driverToken);
  assert.equal(moved.data.address, null);
  assert.equal(moved.data.reason, "limited");
  assert.deepEqual(moved.data.position, { lat: 37.9615, lng: 58.32 });
  assert.equal(providerRequests.length, 1);
});

test("a reloaded shift client consumes the persisted Online grant with refresh exactly once", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  process.env.YANDEX_GEOCODER_CACHE_SECONDS = "300";
  await prisma.driver.update({
    where: { id: driverId },
    data: { isOnline: false, shiftDeviceId: null },
  });
  const path = `/geo/drivers/${driverId}/address`;
  const position = { lat: 37.96, lng: 58.32, capturedAt: Date.now() };
  assert.equal(
    (await request(path, driverToken, { purpose: "off-shift", position })).data
      .reason,
    "resolved",
  );
  assert.equal(
    (await request("/driver/status", driverToken, { isOnline: true, position }))
      .status,
    200,
  );
  // A new app instance restores the account from HTTP, not an in-memory Online
  // event. The persisted server grant must authorize its normal refresh too.
  assert.equal(
    (await request("/driver/profile", driverToken)).data.isOnline,
    true,
  );
  assert.equal(
    (await request(path, driverToken, { purpose: "refresh" })).data.reason,
    "resolved",
  );
  assert.equal(providerRequests.length, 2);
  assert.equal(
    (await request(path, driverToken, { purpose: "refresh" })).data.reason,
    "cached",
  );
  await request("/driver/status", driverToken, { isOnline: false });
  await request("/driver/status", driverToken, {
    isOnline: true,
    position: { ...position, capturedAt: Date.now() },
  });
  assert.equal(
    (await request(path, driverToken, { purpose: "online" })).data.reason,
    "cached",
  );
  assert.equal(providerRequests.length, 2);
});

test("an address older than five minutes refreshes even if licensed retention has not expired", async () => {
  process.env.YANDEX_GEOCODER_API_KEY = "synthetic-private-geocoder";
  process.env.YANDEX_GEOCODER_DAILY_LIMIT = "1000";
  process.env.YANDEX_GEOCODER_QUOTA_TIMEZONE = "UTC";
  process.env.YANDEX_GEOCODER_CACHE_SECONDS = "300";
  const path = `/geo/drivers/${driverId}/address`;
  assert.equal((await request(path, driverToken)).data.reason, "resolved");
  // Provider latency can leave retention valid briefly after the source is
  // five minutes old. Returning it would also return an already-due retryAt.
  await prisma.driverAddressState.update({
    where: { driverId },
    data: {
      attemptedAt: new Date(Date.now() - 301_000),
      cacheUntil: new Date(Date.now() + 5_000),
    },
  });
  const refreshed = await request(path, driverToken);
  assert.equal(refreshed.data.reason, "resolved");
  assert.equal(refreshed.data.address, "Synthetic street, 12");
  assert.ok(Date.parse(refreshed.data.retryAt) > Date.now());
  assert.equal(providerRequests.length, 2);
});
