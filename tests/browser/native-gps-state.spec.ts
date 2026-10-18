import { test, expect } from "@playwright/test";
import { loginFixture, installFixtureSession } from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");

const api = process.env.TEST_API_URL!;
test("native GPS remains local and green during server reconnect and after the shift stops", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const admin = await loginFixture(context.request, "+99360000000");
    const adminHeaders = { Authorization: `Bearer ${admin.accessToken}` };
    const created = await context.request.post(`${api}/admin/drivers`, {
      headers: adminHeaders,
      data: {
        fullName: "Native GPS independence",
        phone: "+99360000744",
        password: process.env.TEST_ACCOUNT_PASSWORD,
      },
    });
    expect(created.status()).toBe(201);
    const driver = await created.json();
    expect(
      (
        await context.request.post(
          `${api}/admin/drivers/${driver.id}/balance`,
          {
            headers: adminHeaders,
            data: {
              operationId: crypto.randomUUID(),
              type: "TOPUP",
              amount: 100,
            },
          },
        )
      ).ok(),
    ).toBe(true);
    const session = await loginFixture(
      context.request,
      "+99360000744",
      "native-gps-state",
    );
    const headers = { Authorization: `Bearer ${session.accessToken}` };
    expect(
      (
        await context.request.post(`${api}/driver/status`, {
          headers,
          data: {
            isOnline: true,
            isAvailable: true,
            position: { lat: 37.96, lng: 58.32, capturedAt: Date.now() },
          },
        })
      ).ok(),
    ).toBe(true);
    await installFixtureSession(context, "driver", session, "native-gps-state");
    await context.addInitScript((userId) => {
      const bridge = window as any;
      bridge.CapacitorCustomPlatform = { name: "android" };
      bridge.nativeGpsState = {
        running: true,
        userId,
        phase: "online",
        detail: "",
        lastReportAt: Date.now(),
        lastFixAt: Date.now() - 10_000,
        stopSequence: 0,
        lat: 37.96,
        lng: 58.32,
        accuracy: 10,
        locationGranted: true,
        locationEnabled: true,
      };
      bridge.Capacitor = {
        PluginHeaders: [
          {
            name: "DriverUi",
            methods: [
              "ready",
              "respondBack",
              "resetBack",
              "detach",
              "theme",
              "removeListener",
            ]
              .map((name) => ({ name, rtype: "promise" }))
              .concat([{ name: "addListener", rtype: "callback" }]),
          },
          {
            name: "DriverNotifications",
            methods: [
              "status",
              "requestPermissions",
              "configure",
              "reconcileOrders",
              "setPresence",
              "deliver",
              "clear",
              "reset",
              "settings",
            ]
              .map((name) => ({ name, rtype: "promise" }))
              .concat([
                { name: "addListener", rtype: "callback" },
                { name: "removeListener", rtype: "promise" },
              ]),
          },
          {
            name: "DriverShift",
            methods: [
              "permissions",
              "status",
              "location",
              "stop",
              "clear",
              "notificationTarget",
              "start",
            ].map((name) => ({ name, rtype: "promise" })),
          },
        ],
        nativeCallback: () => "native-gps-listener",
        nativePromise: async (plugin: string, method: string) => {
          if (plugin === "DriverNotifications")
            return method === "status"
              ? { permission: "denied", enabled: false, configured: false }
              : {};
          return method === "status" || method === "permissions"
            ? { ...bridge.nativeGpsState }
            : {};
        },
      };
    }, driver.userId);
    const page = await context.newPage();
    await page.goto("/driverDashboard");
    const gps = page.getByRole("button", { name: "Включить GPS", exact: true });
    await expect(gps).toHaveAttribute("data-state", "ready");
    await page.evaluate(() => {
      Object.assign((window as any).nativeGpsState, {
        phase: "reconnecting",
        detail: "Связь потеряна",
        lastReportAt: Date.now() - 35_000,
        lastFixAt: Date.now() - 1000,
        lat: 37.961,
        lng: 58.321,
      });
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByLabel("Местоположение GPS")).toContainText(
      "37.9610, 58.3210",
    );
    await expect(gps).toHaveAttribute("data-state", "ready");
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute(
      "aria-description",
      "Нет связи с диспетчером. Переподключаемся.",
    );
    expect(
      (
        await context.request.post(`${api}/driver/status`, {
          headers,
          data: { isOnline: false },
        })
      ).ok(),
    ).toBe(true);
    const offShiftUploads: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/driver/location"))
        offShiftUploads.push(request.url());
    });
    await page.evaluate(() => {
      Object.assign((window as any).nativeGpsState, {
        running: false,
        phase: "off",
        detail: "Смена завершена: связь не восстановлена",
        lastReportAt: 0,
        stopSequence: 1,
        lastFixAt: Date.now() - 1000,
        lat: 37.962,
        lng: 58.322,
      });
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByLabel("Местоположение GPS")).toContainText(
      "37.9620, 58.3220",
    );
    await expect(gps).toHaveAttribute("data-state", "ready");
    await expect(
      page.getByRole("button", { name: "Выйти на линию", exact: true }),
    ).toBeVisible();
    expect(offShiftUploads).toEqual([]);
  } finally {
    await context.close();
  }
});
