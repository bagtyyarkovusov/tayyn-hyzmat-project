import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { installNativeUiFixture } from "./helpers/native-ui";
import { loginFixture, installFixtureSession } from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");

const api = process.env.TEST_API_URL!;

// The Android shift service is an external boundary. The driver's account,
// shift credential and status changes still go through the real API.
async function nativeDriver(context: BrowserContext, phone: string) {
  const admin = await loginFixture(context.request, "+99360000000");
  const adminHeaders = { Authorization: `Bearer ${admin.accessToken}` };
  const created = await context.request.post(`${api}/admin/drivers`, {
    headers: adminHeaders,
    data: {
      fullName: "Native shift handoff",
      phone,
      password: process.env.TEST_ACCOUNT_PASSWORD,
    },
  });
  expect(created.status()).toBe(201);
  const driver = await created.json();
  expect(
    (
      await context.request.post(`${api}/admin/drivers/${driver.id}/balance`, {
        headers: adminHeaders,
        data: { operationId: crypto.randomUUID(), type: "TOPUP", amount: 100 },
      })
    ).ok(),
  ).toBe(true);
  const session = await loginFixture(context.request, phone);
  await installFixtureSession(context, "driver", session);
  await installNativeUiFixture(context, driver.userId);
  await context.addInitScript(() => {
    const host = window as any;
    const original = host.Capacitor.nativePromise;
    // The service starts in the background and connects on its own schedule.
    host.nativeReport = { phase: "connecting", lastReportAt: 0 };
    host.nativeStatusReads = 0;
    host.startHeld = new Promise((release) => (host.releaseStart = release));
    host.Capacitor.nativePromise = async (
      plugin: string,
      method: string,
      options: any,
    ) => {
      if (plugin !== "DriverShift") return original(plugin, method, options);
      if (method === "start") await host.startHeld;
      const result = await original(plugin, method, options);
      if (method !== "status" || !result.running) return result;
      host.nativeStatusReads++;
      return { ...result, ...host.nativeReport };
    };
  });
}

async function screenshotHeader(page: Page, name: string) {
  const header = page.locator("header").filter({
    has: page.getByRole("group", { name: "GPS и связь" }),
  });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await header.screenshot({
      path: test.info().outputPath(`indicator-${name}-${colorScheme}.png`),
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

/** Every state the connection indicator shows, in order, from now on. */
async function recordConnection(page: Page) {
  const connection = page.getByRole("status", { name: /^Связь:/ });
  await expect(connection).toHaveAttribute("data-state", "ready");
  await page.evaluate(() => {
    const host = window as any;
    const element = document.querySelector(
      '[role="status"][aria-label^="Связь:"]',
    )!;
    host.connectionStates = [element.getAttribute("data-state")];
    new MutationObserver(() =>
      host.connectionStates.push(element.getAttribute("data-state")),
    ).observe(element, { attributes: true, attributeFilter: ["data-state"] });
  });
  return connection;
}
const nativeStatusReads = (page: Page) =>
  page.evaluate(() => (window as any).nativeStatusReads as number);

test("starting a native shift keeps the connection indicator green until the service connects, and a later service loss still shows", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    await nativeDriver(context, "+99360000781");
    const page = await context.newPage();
    await page.goto("/driverDashboard");
    const connection = await recordConnection(page);
    await page
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    // The server accepted the shift; the service has not started yet.
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
    await expect(connection).toHaveAttribute("data-state", "ready");
    await page.evaluate(() => (window as any).releaseStart());
    // The service runs but is still connecting through two status reads.
    const reads = await nativeStatusReads(page);
    await expect.poll(() => nativeStatusReads(page)).toBeGreaterThan(reads + 1);
    await page.evaluate(() => {
      (window as any).nativeReport = {
        phase: "online",
        lastReportAt: Date.now(),
      };
    });
    await expect.poll(() => nativeStatusReads(page)).toBeGreaterThan(reads + 2);
    await expect(connection).toHaveAttribute("data-state", "ready");
    expect(await page.evaluate(() => (window as any).connectionStates)).toEqual(
      ["ready"],
    );
    await expect(page.getByRole("status", { name: /^GPS:/ })).toHaveAttribute(
      "data-state",
      "ready",
    );
    await screenshotHeader(page, "online");
    await page.setViewportSize({ width: 360, height: 800 });
    await screenshotHeader(page, "online-360");
    await page.setViewportSize({ width: 390, height: 844 });

    // After the service has connected, losing it is a real disconnection.
    await page.evaluate(() => {
      (window as any).nativeReport = {
        phase: "reconnecting",
        lastReportAt: Date.now() - 35_000,
      };
    });
    await expect(connection).toHaveAttribute("data-state", "reconnecting");
    await screenshotHeader(page, "reconnecting");
    await page.evaluate(() => {
      (window as any).nativeReport = {
        phase: "reconnecting",
        lastReportAt: Date.now() - 35_000,
        leaseRemainingMs: 0,
      };
    });
    await expect(connection).toHaveAttribute("data-state", "disconnected");
  } finally {
    await context.close();
  }
});

test("going offline while a native shift starts shows no connection", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    await nativeDriver(context, "+99360000782");
    const page = await context.newPage();
    await page.goto("/driverDashboard");
    const connection = await recordConnection(page);
    await page
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    await expect(connection).toHaveAttribute("data-state", "disconnected");
    await screenshotHeader(page, "offline");
  } finally {
    await context.close();
  }
});
