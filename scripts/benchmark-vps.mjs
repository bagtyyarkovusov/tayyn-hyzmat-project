#!/usr/bin/env node
// Synthetic local capacity probe. It never accepts a target URL or DATABASE_URL.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(
  new URL("../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const { io } = require("socket.io-client");
const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
if (args.some((arg) => !/^--seconds=\d+$/.test(arg))) {
  throw new Error(
    "Usage: node scripts/benchmark-vps.mjs [--seconds=60]; local disposable resources only",
  );
}
const seconds = Number(args[0]?.split("=")[1] ?? 60);
assert.ok(
  seconds >= 10 && seconds <= 300,
  "Duration must be 10–300 seconds per fleet size",
);
const id = randomBytes(6).toString("hex");
const network = `tayyn-capacity-${id}`;
const db = `${network}-db`;
const api = `${network}-api`;
const image = `tayyn-capacity:${id}`;
const password = randomBytes(24).toString("hex");
const accountPassword = randomBytes(24).toString("hex");
const secrets = [password, accountPassword];
const owned = { db: false, api: false, network: false, image: false };
const sockets = [];
let prisma;
let base;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  startedAt: new Date().toISOString(),
  purpose:
    "Local isolated capacity and backup evidence; not a Railway or purchased-VPS benchmark",
  architecture: process.arch,
  limits: {
    apiMemoryMiB: 512,
    apiCpus: 1,
    databaseMemoryMiB: 1024,
    databaseCpus: 1,
  },
  limitations: [
    "Docker on this Mac uses ARM64 and tmpfs PostgreSQL; this does not establish VPS CPU, durable disk latency, bandwidth, provider connectivity or uptime.",
    "Direct loopback HTTP and WebSockets omit TLS, reverse proxy, real mobile networks and frontend memory.",
    "Synthetic fixture passwords use bcrypt cost 4; measured steady-state load is authenticated and is not a login-storm benchmark.",
    "No external Yandex/FCM requests are made; native tick inbox and real Socket.IO are exercised without vendor delivery.",
    "Short-run history growth extrapolations omit WAL, backups, vacuum bloat and other workload growth; they are not a retention policy.",
    "A one-minute scenario with one synthetic rectangle is a smoke capacity probe, not a long soak or all nine real polygons; CPU samples can miss brief peaks.",
  ],
  scenarios: [],
};
function safe(value) {
  let text = String(value);
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text;
}
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      safe(
        `${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`,
      ),
    );
  }
  return typeof result.stdout === "string"
    ? result.stdout.trim()
    : result.stdout;
}
function cleanup() {
  const failures = [];
  sockets.splice(0).forEach((socket) => socket.disconnect());
  for (const [key, commandArgs] of [
    ["api", ["rm", "-f", "-v", api]],
    ["db", ["rm", "-f", "-v", db]],
    ["network", ["network", "rm", network]],
    ["image", ["image", "rm", image]],
  ]) {
    if (!owned[key]) continue;
    const result = spawnSync("docker", commandArgs, {
      stdio: "ignore",
      timeout: 15_000,
    });
    if (result.status === 0 && !result.error) owned[key] = false;
    else {
      const resource = { api, db, network, image }[key];
      failures.push(resource);
      console.error(
        `Cleanup failed; inspect this benchmark-owned resource: ${resource}`,
      );
    }
  }
  return failures;
}
function assertLocalDocker() {
  const local = (endpoint) => /^(unix:\/\/\/|npipe:\/\/)/.test(endpoint);
  if (process.env.DOCKER_HOST && !local(process.env.DOCKER_HOST))
    throw new Error(
      "Refusing benchmark mutations: Docker must use a local unix/npipe endpoint, not TCP/SSH.",
    );
  // DOCKER_CONTEXT can override DOCKER_HOST, so validate both when supplied.
  if (process.env.DOCKER_CONTEXT || !process.env.DOCKER_HOST) {
    const context =
      process.env.DOCKER_CONTEXT || run("docker", ["context", "show"]);
    const endpoint = run("docker", [
      "context",
      "inspect",
      context,
      "--format",
      "{{.Endpoints.docker.Host}}",
    ]);
    if (!local(endpoint))
      throw new Error(
        "Refusing benchmark mutations: selected Docker context is not a local unix/npipe endpoint.",
      );
  }
}
process.once("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
function sql(statement, database = "tayyn_capacity_test") {
  return run("docker", [
    "exec",
    db,
    "psql",
    "-U",
    "postgres",
    "-d",
    database,
    "-At",
    "-c",
    statement,
  ]);
}
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (fraction) =>
    Math.round(
      (sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0) * 10,
    ) / 10;
  return {
    count: values.length,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    maxMs: pick(1),
  };
}
async function request(path, session, body, expected = [200], metrics) {
  const started = performance.now();
  let status = 0;
  try {
    const response = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `127.2.0.${session?.index ?? 1}`,
        ...(session?.token ? { Authorization: `Bearer ${session.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    status = response.status;
    const data = status === 204 ? null : await response.json();
    assert.ok(expected.includes(status), `${path}: unexpected HTTP ${status}`);
    return { status, data };
  } finally {
    if (metrics) {
      const group = (metrics.routes[path] ??= { times: [], statuses: {} });
      group.times.push(performance.now() - started);
      group.statuses[status] = (group.statuses[status] ?? 0) + 1;
      if (!expected.includes(status)) metrics.unexpectedErrors++;
    }
  }
}
async function socketFor(session, metrics) {
  const socket = io(base, {
    auth: { token: session.token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Socket connection timeout")),
      10_000,
    );
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", () => {
      clearTimeout(timeout);
      reject(new Error("Socket authentication/connect failed"));
    });
  });
  socket.on("disconnect", () => {
    metrics.disconnects++;
  });
  socket.on("districts:stats", () => {
    metrics.statsEvents++;
  });
  return socket;
}
async function fleet(count) {
  const metrics = {
    routes: {},
    unexpectedErrors: 0,
    disconnects: 0,
    statsEvents: 0,
    locationEvents: 0,
  };
  const hash = await bcrypt.hash(accountPassword, 4);
  const region = await prisma.district.findFirstOrThrow();
  const admin = {
    index: 1,
    token: (
      await request(
        "/auth/login",
        { index: 1 },
        {
          phone: "+99360000000",
          password: accountPassword,
          deviceId: `capacity-admin-${id}`,
        },
      )
    ).data.accessToken,
  };
  const adminSocket = await socketFor(admin, metrics);
  adminSocket.on("driver:location", () => {
    metrics.locationEvents++;
  });
  const sessions = [];
  for (let i = 0; i < count; i++) {
    const phone = `+99360${String(count * 100 + i).padStart(6, "0")}`;
    await prisma.user.create({
      data: {
        phone,
        fullName: "SYNTHETIC CAPACITY DRIVER",
        role: "DRIVER",
        passwordHash: hash,
        driver: { create: { status: "APPROVED" } },
        balance: { create: { amount: 10000, currency: "TMT" } },
      },
    });
    const session = { index: i + 2, deviceId: `capacity-${count}-${i}-${id}` };
    const login = await request("/auth/login", session, {
      phone,
      password: accountPassword,
      deviceId: session.deviceId,
    });
    session.token = login.data.accessToken;
    session.refreshToken = login.data.refreshToken;
    await request("/driver/status", session, {
      isOnline: true,
      isAvailable: true,
      position: { lat: 37.96, lng: 58.32, capturedAt: Date.now() },
    });
    const lease = await request(
      "/driver/shift",
      session,
      { deviceId: session.deviceId, refreshToken: session.refreshToken },
      [201],
    );
    session.native = { ...session, token: lease.data.shiftToken };
    await socketFor(session, metrics);
    sessions.push(session);
  }
  await sleep(200); // connect completes before asynchronous authenticated rooms join
  const beforeRows = Number(sql("SELECT count(*) FROM driver_locations"));
  const beforeBytes = Number(
    sql("SELECT pg_total_relation_size('driver_locations')"),
  );
  const began = performance.now();
  const samples = [];
  let completed = 0;
  let expectedCompetitionConflicts = 0;
  let orderRound = 0;
  const driverLoops = sessions.map(async (session, index) => {
    await sleep((index / count) * 2000);
    while (performance.now() - began < seconds * 1000) {
      const tick = await request(
        "/native-shift/tick",
        session.native,
        {
          lat: 37.96 + index * 0.00001,
          lng: 58.32,
          accuracy: 10,
          recordedAt: new Date().toISOString(),
        },
        [200],
        metrics,
      );
      assert.ok(
        Array.isArray(tick.data.events),
        "Native tick returns the notification inbox",
      );
      await request("/orders/available", session, undefined, [200], metrics);
      await sleep(
        Math.min(
          10_000,
          Math.max(0, seconds * 1000 - (performance.now() - began)),
        ),
      );
    }
  });
  const orderLoop = (async () => {
    await sleep(2500);
    while (performance.now() - began < seconds * 1000 - 2000) {
      const created = await request(
        "/admin/orders",
        admin,
        {
          districtId: region.id,
          priceEstimated: 10,
          pickupAddress: "SYNTHETIC CAPACITY PICKUP",
          clientPhone: "+99360000999",
        },
        [201],
        metrics,
      );
      const contenders = [
        sessions[orderRound % count],
        sessions[(orderRound + 1) % count],
      ];
      const claims = await Promise.all(
        contenders.map((session) =>
          request(
            "/orders/accept",
            session,
            { orderId: created.data.id, arrivalMinutes: 5 },
            [200, 409],
            metrics,
          ),
        ),
      );
      assert.equal(
        claims.filter((claim) => claim.status === 200).length,
        1,
        "Exactly one competing driver wins",
      );
      assert.equal(
        claims.filter((claim) => claim.status === 409).length,
        1,
        "The losing claim is rejected",
      );
      expectedCompetitionConflicts++;
      const winner =
        contenders[claims.findIndex((claim) => claim.status === 200)];
      const queue = await request(
        "/orders/available",
        contenders.find((session) => session !== winner),
        undefined,
        [200],
        metrics,
      );
      assert.ok(
        !queue.data.some((order) => order.id === created.data.id),
        "Claimed order disappears from other driver's public feed",
      );
      for (const action of ["waiting", "start", "complete"]) {
        await request(
          `/orders/${action}`,
          winner,
          { orderId: created.data.id },
          [200],
          metrics,
        );
      }
      completed++;
      orderRound++;
      await sleep(
        Math.min(
          10_000,
          Math.max(0, seconds * 1000 - (performance.now() - began)),
        ),
      );
    }
  })();
  const sampler = (async () => {
    while (performance.now() - began < seconds * 1000) {
      samples.push(
        JSON.parse(
          (
            await execFileAsync(
              "docker",
              ["stats", "--no-stream", "--format", "{{json .}}", api],
              { timeout: 10_000, maxBuffer: 64 * 1024 },
            )
          ).stdout,
        ),
      );
      await sleep(4000);
    }
  })();
  await Promise.all([...driverLoops, orderLoop, sampler]);
  const elapsedSeconds = (performance.now() - began) / 1000;
  const historyRows =
    Number(sql("SELECT count(*) FROM driver_locations")) - beforeRows;
  const afterBytes = Number(
    sql("SELECT pg_total_relation_size('driver_locations')"),
  );
  const tableBytes = afterBytes - beforeBytes;
  const actualHistoryBytesPerRow = Number(
    sql("SELECT coalesce(avg(pg_column_size(t)),0) FROM driver_locations t"),
  );
  const apiRssKiB = Number(
    run("docker", [
      "exec",
      api,
      "node",
      "-e",
      "console.log(require('fs').readFileSync('/proc/1/status','utf8').match(/^VmRSS:\\s+(\\d+)/m)[1])",
    ]),
  );
  const result = {
    drivers: count,
    elapsedSeconds: Math.round(elapsedSeconds * 10) / 10,
    completedTrips: completed,
    expectedCompetitionConflicts,
    unexpectedErrors: metrics.unexpectedErrors,
    unexpectedSocketDisconnects: metrics.disconnects,
    driverStatsEventsReceived: metrics.statsEvents,
    dispatcherLocationEventsReceived: metrics.locationEvents,
    locationRowsWritten: historyRows,
    locationTableAllocatedGrowthBytes: tableBytes,
    locationRowLogicalBytes: actualHistoryBytesPerRow,
    projectedLocationRowsPer12HourShift: count * 4320,
    projectedLocationLogicalMiBPer12HourShift:
      Math.round((count * 4320 * actualHistoryBytesPerRow) / 104857.6) / 10,
    apiRssMiBAtEnd: Math.round(apiRssKiB / 102.4) / 10,
    dockerApiSamples: samples.map(({ CPUPerc, MemUsage, MemPerc }) => ({
      cpu: CPUPerc,
      memory: MemUsage,
      percentOf512MiBLimit: MemPerc,
    })),
    http: Object.fromEntries(
      Object.entries(metrics.routes).map(([route, group]) => [
        route,
        { ...summary(group.times), statuses: group.statuses },
      ]),
    ),
  };
  assert.equal(metrics.unexpectedErrors, 0);
  assert.equal(metrics.disconnects, 0);
  assert.ok(
    metrics.locationEvents >= count,
    "Dispatcher receives live GPS updates",
  );
  assert.ok(
    metrics.statsEvents >= count,
    "Drivers receive region-stat broadcasts",
  );
  for (const session of sessions)
    await request("/driver/status", session, { isOnline: false });
  sockets.splice(0).forEach((socket) => socket.disconnect());
  return result;
}
function fingerprint(database) {
  return sql(
    "SELECT json_build_object('users',(SELECT count(*) FROM users),'drivers',(SELECT count(*) FROM drivers),'orders',(SELECT count(*) FROM orders),'completed',(SELECT count(*) FROM orders WHERE status='COMPLETED'),'locations',(SELECT count(*) FROM driver_locations),'transactions',(SELECT count(*) FROM transactions),'ledgerSum',(SELECT sum(amount)::text FROM transactions),'walletSum',(SELECT sum(amount)::text FROM balances),'walletDigest',(SELECT md5(string_agg(id::text || ':' || user_id::text || ':' || amount::text || ':' || currency, ',' ORDER BY id)) FROM balances),'accountDigest',(SELECT md5(string_agg(id::text || ':' || phone || ':' || role::text || ':' || status::text, ',' ORDER BY id)) FROM users),'ledgerDigest',(SELECT md5(string_agg(t.id::text || ':' || t.balance_id::text || ':' || b.user_id::text || ':' || coalesce(t.order_id::text,'') || ':' || t.amount::text || ':' || t.balance_after::text || ':' || t.type::text || ':' || t.status::text || ':' || t.currency, ',' ORDER BY t.id)) FROM transactions t JOIN balances b ON b.id=t.balance_id),'orderDigest',(SELECT md5(string_agg(id::text || ':' || status::text || ':' || order_number::text || ':' || coalesce(driver_id::text,''), ',' ORDER BY id)) FROM orders))",
    database,
  );
}
try {
  assertLocalDocker();
  report.docker = JSON.parse(run("docker", ["info", "--format", "{{json .}}"]));
  report.docker = {
    serverVersion: report.docker.ServerVersion,
    architecture: report.docker.Architecture,
    memoryBytes: report.docker.MemTotal,
  };
  console.log(
    "Building current API; no external application or database target is accepted.",
  );
  run("docker", ["build", "-t", image, "backend"], { timeout: 180_000 });
  owned.image = true;
  report.imageId = run("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    image,
  ]);
  report.sourceCommit = run("git", ["rev-parse", "HEAD"]);
  run("docker", ["network", "create", network]);
  owned.network = true;
  run("docker", [
    "run",
    "-d",
    "--name",
    db,
    "--network",
    network,
    "--network-alias",
    "db",
    "--memory",
    "1g",
    "--cpus",
    "1",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=tayyn_capacity_test",
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,size=536870912",
    "postgres:17-alpine",
  ]);
  owned.db = true;
  for (let attempt = 0; ; attempt++) {
    if (
      spawnSync("docker", ["exec", db, "pg_isready", "-U", "postgres"], {
        stdio: "ignore",
        timeout: 5000,
      }).status === 0
    )
      break;
    assert.ok(attempt < 60, "Disposable DB startup timed out");
    await sleep(500);
  }
  const containerUrl = `postgresql://postgres:${password}@db:5432/tayyn_capacity_test?connection_limit=10`;
  run("docker", [
    "run",
    "--rm",
    "--network",
    network,
    "--memory",
    "512m",
    "-e",
    `DATABASE_URL=${containerUrl}`,
    image,
    "pnpm",
    "exec",
    "prisma",
    "migrate",
    "deploy",
  ]);
  const dbPort = run("docker", ["port", db, "5432/tcp"]).split(":").at(-1);
  prisma = new PrismaClient({
    datasources: {
      db: {
        url: `postgresql://postgres:${password}@127.0.0.1:${dbPort}/tayyn_capacity_test`,
      },
    },
  });
  await prisma.user.create({
    data: {
      phone: "+99360000000",
      fullName: "SYNTHETIC CAPACITY ADMIN",
      role: "ADMIN",
      passwordHash: await bcrypt.hash(accountPassword, 4),
      admin: { create: { permissionLevel: "SUPER" } },
    },
  });
  await prisma.district.create({
    data: {
      name: "SYNTHETIC CAPACITY REGION",
      centerLat: 37.96,
      centerLng: 58.32,
      boundary: [
        [
          [37.94, 58.3],
          [37.98, 58.3],
          [37.98, 58.36],
          [37.94, 58.36],
        ],
      ],
    },
  });
  const access = randomBytes(32).toString("hex");
  const refresh = randomBytes(32).toString("hex");
  secrets.push(access, refresh);
  run("docker", [
    "run",
    "-d",
    "--name",
    api,
    "--network",
    network,
    "--memory",
    "512m",
    "--cpus",
    "1",
    "-p",
    "127.0.0.1::4000",
    "-e",
    "NODE_ENV=production",
    "-e",
    "LOG_LEVEL=silent",
    "-e",
    `DATABASE_URL=${containerUrl}`,
    "-e",
    `JWT_ACCESS_SECRET=${access}`,
    "-e",
    `JWT_REFRESH_SECRET=${refresh}`,
    image,
  ]);
  owned.api = true;
  base = `http://127.0.0.1:${run("docker", ["port", api, "4000/tcp"]).split(":").at(-1)}`;
  for (let attempt = 0; ; attempt++) {
    try {
      if (
        (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) }))
          .ok
      )
        break;
    } catch {}
    assert.ok(attempt < 100, "Disposable API startup timed out");
    await sleep(200);
  }
  for (const count of [5, 50]) {
    console.log(
      `Running ${count} drivers for ${seconds} seconds with 10-second native GPS/inbox ticks, live sockets and competing trip claims.`,
    );
    const scenario = await fleet(count);
    report.scenarios.push(scenario);
    console.log(
      JSON.stringify({
        drivers: count,
        completedTrips: scenario.completedTrips,
        unexpectedErrors: scenario.unexpectedErrors,
        apiRssMiB: scenario.apiRssMiBAtEnd,
      }),
    );
  }
  const before = fingerprint("tayyn_capacity_test");
  const started = performance.now();
  const dump = run(
    "docker",
    [
      "exec",
      db,
      "pg_dump",
      "-U",
      "postgres",
      "-d",
      "tayyn_capacity_test",
      "-Fc",
    ],
    { encoding: null },
  );
  const dumpMs = performance.now() - started;
  sql("CREATE DATABASE tayyn_capacity_restore");
  const restoreStart = performance.now();
  run(
    "docker",
    [
      "exec",
      "-i",
      db,
      "pg_restore",
      "-U",
      "postgres",
      "-d",
      "tayyn_capacity_restore",
      "--exit-on-error",
      "--no-owner",
    ],
    { input: dump },
  );
  const restoreMs = performance.now() - restoreStart;
  const after = fingerprint("tayyn_capacity_restore");
  assert.equal(
    after,
    before,
    "Restored account/order/location counts, order IDs/statuses/numbers, balances and ledger entries agree",
  );
  report.backup = {
    databaseBytes: Number(sql("SELECT pg_database_size(current_database())")),
    compressedCustomDumpBytes: dump.length,
    sha256: createHash("sha256").update(dump).digest("hex"),
    dumpMs: Math.round(dumpMs),
    restoreMs: Math.round(restoreMs),
    integrity: JSON.parse(before),
    restoredIntegrityMatches: true,
    note: "Small synthetic DB; no real storage, encryption, off-site upload, retention, WAL archiving or disaster recovery throughput measured.",
  };
  report.finishedAt = new Date().toISOString();
} catch (error) {
  console.error(safe(error.message));
  process.exitCode = 1;
} finally {
  try {
    await prisma?.$disconnect();
  } catch {
    console.error(
      "Synthetic fixture client disconnect failed; continuing owned-resource cleanup.",
    );
    process.exitCode = 1;
  }
  report.cleanupFailures = cleanup();
  if (report.cleanupFailures.length) process.exitCode = 1;
  if (report.finishedAt) {
    const directory = new URL("../.local/vps-readiness/", import.meta.url);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      new URL("capacity.json", directory),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (!process.exitCode)
      console.log(
        "PASS: isolated workload, verified dump/restore and cleanup; evidence in .local/vps-readiness/capacity.json",
      );
  }
}
