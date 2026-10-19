import { test, expect, type BrowserContext } from "@playwright/test";
import { createRequire } from "node:module";
import { installNativeUiFixture } from "./helpers/native-ui";
import { loginFixture, installFixtureSession } from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");

const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
const ownedUsers: string[] = [];
test.afterEach(async () => {
  const ids = ownedUsers.splice(0);
  if (!ids.length) return;
  const prisma = new PrismaClient();
  try {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  } finally {
    await prisma.$disconnect();
  }
});

async function fixture(context: BrowserContext, phone: string) {
  const admin = await loginFixture(context.request, "+99360000000");
  const created = await context.request.post(
    `${process.env.TEST_API_URL}/admin/drivers`,
    {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
      data: {
        fullName: "GPS reliability",
        phone,
        password: process.env.TEST_ACCOUNT_PASSWORD,
      },
    },
  );
  expect(created.status()).toBe(201);
  const createdDriver = await created.json();
  ownedUsers.push(createdDriver.userId);
  const session = await loginFixture(context.request, phone);
  await installFixtureSession(context, "driver", session);
  await context.addInitScript(() => {
    const boundary = window as any;
    boundary.gpsRequests = [];
    boundary.gpsWatches = new Map();
    let id = 0;
    Object.defineProperty(navigator, "geolocation", {
      value: {
        getCurrentPosition: (success: any, failed: any) =>
          boundary.gpsRequests.push({ success, failed }),
        watchPosition: (success: any, failed: any) => {
          boundary.gpsWatches.set(++id, { success, failed });
          return id;
        },
        clearWatch: (watch: number) => boundary.gpsWatches.delete(watch),
      },
    });
    boundary.freshGps = (request: number) =>
      boundary.gpsRequests[request].success({
        coords: {
          latitude: 37.96,
          longitude: 58.32,
          accuracy: 10,
          heading: null,
          speed: null,
        },
        timestamp: Date.now(),
      });
  });
  return session;
}

test("dashboard GPS and connection are passive icons while searching and offline", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    await fixture(context, "+99360000745");
    const page = await context.newPage();
    await page.goto("/driverDashboard");
    const indicators = page.getByRole("group", { name: "GPS и связь" });
    await expect(indicators.getByRole("button")).toHaveCount(0);
    await expect(indicators.getByRole("status")).toHaveCount(2);
    await expect(indicators).toHaveText("");
    await expect(
      indicators.locator("[title], [tabindex], [aria-haspopup]"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("status", { name: "GPS: поиск" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Ожидаем GPS|Получаем местоположение|Последнее обновление|Нажмите GPS/,
      ),
    ).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("gps-searching-light.png"),
    });
    await context.setOffline(true);
    await expect(
      page.getByRole("status", { name: "Связь: нет соединения" }),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Нет интернета|Переподключаемся|Связь с диспетчером прервана/,
      ),
    ).toHaveCount(0);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(indicators).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("gps-offline-dark.png"),
    });
  } finally {
    await context.close();
  }
});

test("initial GPS timeout retries automatically without parallel requests and ignores callbacks after logout", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await fixture(context, "+99360000746");
    const page = await context.newPage();
    await page.clock.install();
    await page.goto("/driverDashboard");
    await expect
      .poll(() => page.evaluate(() => (window as any).gpsRequests.length))
      .toBe(1);
    await page.clock.fastForward(30_000);
    expect(await page.evaluate(() => (window as any).gpsRequests.length)).toBe(
      1,
    );
    await page.evaluate(() =>
      (window as any).gpsRequests[0].failed({
        code: 3,
        TIMEOUT: 3,
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
      }),
    );
    await page.clock.fastForward(11_000);
    await expect
      .poll(() => page.evaluate(() => (window as any).gpsRequests.length))
      .toBe(2);
    await page.evaluate(() => (window as any).freshGps(1));
    await expect(
      page.getByRole("status", { name: "GPS: актуальные координаты" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Профиль", exact: true }).click();
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/driverLogin/);
    await page.evaluate(() => (window as any).freshGps(0));
    await page.clock.fastForward(120_000);
    expect(await page.evaluate(() => (window as any).gpsWatches.size)).toBe(0);
    expect(await page.evaluate(() => (window as any).gpsRequests.length)).toBe(
      2,
    );
  } finally {
    await context.close();
  }
});

test("hidden off-shift acquisition is cancelled and stale callbacks cannot replace the next visible fix", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    await fixture(context, "+99360000747");
    const page = await context.newPage();
    await page.clock.install();
    await page.goto("/driverDashboard");
    await expect
      .poll(() => page.evaluate(() => (window as any).gpsRequests.length))
      .toBe(1);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.fastForward(120000);
    expect(await page.evaluate(() => (window as any).gpsRequests.length)).toBe(
      1,
    );
    expect(await page.evaluate(() => (window as any).gpsWatches.size)).toBe(0);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).gpsRequests.length))
      .toBe(2);
    await page.evaluate(() => (window as any).freshGps(1));
    await expect(page.getByRole("status", { name: /^GPS:/ })).toHaveAttribute(
      "data-state",
      "ready",
    );
    await page.evaluate(() =>
      (window as any).gpsRequests[0].success({
        coords: { latitude: 0, longitude: 0, accuracy: 5 },
        timestamp: Date.now(),
      }),
    );
    await expect(page.getByLabel("Местоположение GPS")).toContainText(
      "37.9600, 58.3200",
    );
  } finally {
    await context.close();
  }
});

test("native acquisition retries after timeout without prompting, and Online owns coarse/location-off recovery", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const session = await fixture(context, "+99360000748");
    await installNativeUiFixture(context, (session.user as any).id);
    await context.addInitScript(() => {
      const host = window as any;
      const original = host.Capacitor.nativePromise;
      host.locationAttempts = 0;
      host.permissionAttempts = 0;
      host.coarseOnly = false;
      host.locationOff = false;
      host.Capacitor.nativePromise = async (
        plugin: string,
        method: string,
        options: any,
      ) => {
        if (plugin !== "DriverShift") return original(plugin, method, options);
        if (method === "permissions") {
          host.permissionAttempts++;
          // Model the external Android permission/location prompt being accepted.
          host.coarseOnly = false;
          host.locationOff = false;
        }
        if (method === "location") {
          host.locationAttempts++;
          if (host.locationAttempts === 1)
            throw new Error("Synthetic native acquisition timeout");
        }
        const result = await original(plugin, method, options);
        return method === "status" || method === "permissions"
          ? {
              ...result,
              lastFixAt: 0,
              locationGranted: !host.coarseOnly,
              locationEnabled: !host.locationOff,
            }
          : result;
      };
    });
    // Give the synthetic driver a positive balance, through the public API.
    const admin = await loginFixture(context.request, "+99360000000");
    const profile = await context.request.get(
      `${process.env.TEST_API_URL}/driver/profile`,
      { headers: { Authorization: `Bearer ${session.accessToken}` } },
    );
    const { id } = await profile.json();
    expect(
      (
        await context.request.post(
          `${process.env.TEST_API_URL}/admin/drivers/${id}/balance`,
          {
            headers: { Authorization: `Bearer ${admin.accessToken}` },
            data: {
              operationId: crypto.randomUUID(),
              type: "TOPUP",
              amount: 100,
            },
          },
        )
      ).ok(),
    ).toBe(true);
    const page = await context.newPage();
    await page.clock.install({ time: new Date(Date.now() - 11000) });
    await page.goto("/driverDashboard");
    await expect
      .poll(() => page.evaluate(() => (window as any).locationAttempts))
      .toBe(1);
    await page.clock.fastForward(11000);
    await expect(page.getByRole("status", { name: /^GPS:/ })).toHaveAttribute(
      "data-state",
      "ready",
    );
    expect(await page.evaluate(() => (window as any).permissionAttempts)).toBe(
      0,
    );
    for (const blocker of ["coarseOnly", "locationOff"]) {
      await page.evaluate((key) => {
        (window as any)[key] = true;
        window.dispatchEvent(new Event("focus"));
      }, blocker);
      await expect(page.getByRole("status", { name: /^GPS:/ })).toHaveAttribute(
        "data-state",
        "blocked",
      );
      const online = page.getByRole("button", {
        name: "Выйти на линию",
        exact: true,
      });
      await expect(online).toBeEnabled();
      await online.click();
      await expect(
        page.getByRole("button", { name: "Уйти с линии", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Уйти с линии", exact: true })
        .click();
      await expect(online).toBeVisible();
    }
    expect(await page.evaluate(() => (window as any).permissionAttempts)).toBe(
      2,
    );
  } finally {
    await context.close();
  }
});
