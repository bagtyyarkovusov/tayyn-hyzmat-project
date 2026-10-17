import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
const root = new URL("../", import.meta.url).pathname;
const require = createRequire(
  new URL("../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
const id = randomBytes(8).toString("hex");
const container = `tayyn-browser-${id}`;
const password = randomBytes(20).toString("hex");
const accountPassword = "SyntheticBrowser123!";
let created = false;
const children = [];
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8" });
  if (result.status !== 0 || result.error)
    throw new Error(
      `${command} ${args[0]} failed: ${result.error?.message || result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
}
function cleanup() {
  for (const child of children) child.kill("SIGTERM");
  if (created) {
    created = false;
    run("docker", ["rm", "-f", "-v", container]);
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
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
async function wait(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Service did not start: ${url}`);
}
try {
  run("docker", [
    "run",
    "-d",
    "--name",
    container,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    "POSTGRES_DB=tayyn_browser_test",
    "-p",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql/data:rw",
    "postgres:17-alpine",
  ]);
  created = true;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (
      spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], {
        stdio: "ignore",
      }).status === 0
    ) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!ready) throw new Error("Disposable database not ready");
  const dbPort = run("docker", ["port", container, "5432/tcp"])
    .split(":")
    .at(-1);
  const serving = process.argv.includes("--serve");
  const apiPort =
    serving && process.env.TAYYN_PREVIEW_API_PORT
      ? Number(process.env.TAYYN_PREVIEW_API_PORT)
      : await port();
  const webPort =
    serving && process.env.TAYYN_PREVIEW_WEB_PORT
      ? Number(process.env.TAYYN_PREVIEW_WEB_PORT)
      : await port();
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${dbPort}/tayyn_browser_test`,
    JWT_ACCESS_SECRET: randomBytes(32).toString("hex"),
    JWT_REFRESH_SECRET: randomBytes(32).toString("hex"),
    NODE_ENV: "test",
    YANDEX_GEOCODER_API_KEY: "synthetic-private-test-key",
    YANDEX_GEOCODER_DAILY_LIMIT: "1000",
    YANDEX_GEOCODER_QUOTA_TIMEZONE: "UTC",
    YANDEX_GEOCODER_CACHE_SECONDS: "0",
    LOG_LEVEL: "silent",
    PORT: String(apiPort),
    CORS_ORIGIN: `http://127.0.0.1:${webPort}`,
    TAYYN_TEST_API: `http://127.0.0.1:${apiPort}`,
    VITE_API_URL: "/api",
    VITE_SOCKET_URL: `http://127.0.0.1:${webPort}`,
    // Browser specs replace only the external map SDK, never internal APIs.
    VITE_YANDEX_MAPS_API_KEY: serving ? "" : "synthetic-browser-test-key",
    VUE_APP_YANDEX_MAPS_API_KEY: "",
    DISPOSABLE_BROWSER_TEST: "true",
    TAYYN_TEST_STATIC: serving ? "false" : "true",
    TEST_BASE_URL: `http://127.0.0.1:${webPort}`,
    TEST_API_URL: `http://127.0.0.1:${apiPort}`,
    TEST_ACCOUNT_PASSWORD: accountPassword,
  };
  // Supplied DATABASE_URL/credentials are overwritten, never used as a test target.
  run("pnpm", ["--filter", "openride-backend", "prisma:generate"], env);
  run("pnpm", ["build:backend"], env);
  run(
    "pnpm",
    ["--filter", "openride-backend", "exec", "prisma", "migrate", "deploy"],
    env,
  );
  const prisma = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
  });
  try {
    const passwordHash = await bcrypt.hash(accountPassword, 4);
    await prisma.user.create({
      data: {
        phone: "+99360000000",
        fullName: "Тестовый диспетчер",
        role: "ADMIN",
        passwordHash,
        admin: { create: { permissionLevel: "SUPER" } },
      },
    });
    let region;
    if (serving) {
      const { seedDefaultRegions } = require("./prisma/default-regions.cjs");
      await prisma.$transaction(seedDefaultRegions);
      region = await prisma.district.findFirstOrThrow({
        orderBy: { name: "asc" },
      });
    } else
      region = await prisma.district.create({
        data: {
          name: "ТЕСТ — Центральный",
          centerLat: 37.96,
          centerLng: 58.32,
          boundary: [
            [
              [37.94, 58.3],
              [37.98, 58.3],
              [37.98, 58.36],
              [37.94, 58.36],
              [37.94, 58.3],
            ],
          ],
        },
      });
    if (!serving) {
      await prisma.district.createMany({
        data: [
          "Гуртлы",
          "Анау, Гами",
          "Аркадаг, Ялкым",
          "Арчабил, Бекреве",
          "Микрорайон",
          "Мир",
          "Хитровка, Бедев",
          "Чоганлы, Гарадамак",
        ].map((name) => ({
          name: `ТЕСТ · ${name}`,
          centerLat: 0,
          centerLng: 0,
        })),
      });
    }
    env.TEST_REGION_ID = region.id;
    for (const [phone, name] of [
      ["+99360000101", "Тестовый водитель"],
      ["+99360000102", "Второй водитель"],
      ["+99360000103", "Водитель для проверки обновлений"],
    ])
      await prisma.user.create({
        data: {
          phone,
          fullName: name,
          role: "DRIVER",
          passwordHash,
          driver: { create: { status: "APPROVED", districtId: region.id } },
          balance: { create: { amount: 500, currency: "TMT" } },
        },
      });
  } finally {
    await prisma.$disconnect();
  }
  for (const [command, args] of [
    [
      "node",
      ["--require", "./tests/fixtures/geocoder.cjs", "backend/dist/server.js"],
    ],
    [
      "pnpm",
      ["exec", "vite", "--host", "127.0.0.1", "--port", String(webPort)],
    ],
  ]) {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    children.push(child);
  }
  await wait(`${env.TEST_API_URL}/health`);
  await wait(env.TEST_BASE_URL);
  if (process.argv.includes("--serve")) {
    mkdirSync(`${root}.local`, { recursive: true });
    writeFileSync(
      `${root}.local/browser-context.json`,
      JSON.stringify({
        baseURL: env.TEST_BASE_URL,
        apiURL: env.TEST_API_URL,
        password: accountPassword,
        regionId: env.TEST_REGION_ID,
      }),
    );
    chmodSync(`${root}.local/browser-context.json`, 0o600);
    console.log(
      "Isolated synthetic browser environment ready; stop this process to remove it.",
    );
    await new Promise(() => {});
  }
  const result = spawn(
    "pnpm",
    ["exec", "playwright", "test", ...process.argv.slice(2)],
    {
      cwd: root,
      env,
      stdio: "inherit",
    },
  );
  const code = await new Promise((r) => result.once("exit", r));
  if (code !== 0) throw new Error(`Browser tests failed: ${code}`);
} finally {
  cleanup();
}
