import { test, expect, type Browser } from "@playwright/test";
import { createRequire } from "node:module";
import { loginFixture, installFixtureSession } from "./helpers/device-session";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");

async function fixture(browser: Browser) {
  const prisma = new PrismaClient();
  const admin = await prisma.user.findUniqueOrThrow({
    where: { phone: "+99360000000" },
  });
  const user = await prisma.user.create({
    data: {
      phone: `+993${String(Date.now()).slice(-8)}`,
      fullName: "Водитель уведомлений",
      role: "DRIVER",
      passwordHash: admin.passwordHash,
      balance: { create: { amount: 500 } },
      driver: { create: { status: "APPROVED" } },
    },
    include: { driver: true },
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const deviceId = `notifications-${user.id}`;
  const driverSession = await loginFixture(
    context.request,
    user.phone,
    deviceId,
  );
  await installFixtureSession(context, "driver", driverSession, deviceId);
  const adminSession = await loginFixture(context.request, admin.phone);
  const page = await context.newPage();
  return {
    page,
    context,
    settings: async () => {
      const response = await context.request.get(
        `${process.env.TEST_API_URL}/driver/notifications/settings`,
        { headers: { Authorization: `Bearer ${driverSession.accessToken}` } },
      );
      expect(response.ok()).toBe(true);
      return response.json();
    },
    markRead: async (messageId: string) => {
      const response = await context.request.post(
        `${process.env.TEST_API_URL}/driver/messages/read`,
        {
          headers: { Authorization: `Bearer ${driverSession.accessToken}` },
          data: { throughMessageId: messageId },
        },
      );
      expect(response.ok()).toBe(true);
    },
    send: async (body: string) => {
      const response = await context.request.post(
        `${process.env.TEST_API_URL}/admin/messages`,
        {
          headers: { Authorization: `Bearer ${adminSession.accessToken}` },
          data: {
            driverId: user.driver.id,
            body,
            clientMessageId: crypto.randomUUID(),
          },
        },
      );
      expect(response.ok()).toBe(true);
      return response.json();
    },
    close: async () => {
      await context.close();
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.$disconnect();
    },
  };
}

async function spyOnBrowserNotifications(
  page: import("@playwright/test").Page,
) {
  await page.addInitScript(() => {
    const notices: string[] = [];
    const tray: FakeNotification[] = [];
    class FakeNotification {
      static permission = "granted" as NotificationPermission;
      onclick: (() => void) | null = null;
      closed = false;
      constructor(_title: string, options: NotificationOptions) {
        notices.push(options.body || "");
        tray.push(this);
      }
      close() {
        this.closed = true;
      }
    }
    Object.defineProperty(window, "__notificationBodies", {
      value: notices,
      configurable: true,
    });
    Object.defineProperty(window, "Notification", {
      value: FakeNotification,
      configurable: true,
    });
    Object.defineProperty(window, "__notificationTray", { value: tray });
  });
}

test("one Profile notification switch mutes alerts without blocking the driver's shift", async ({
  browser,
}) => {
  const { page, close } = await fixture(browser);
  try {
    await page.goto("/driverProfile");
    const toggle = page.getByRole("switch", {
      name: "Уведомления",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.goto("/driverDashboard");
    await expect(
      page.getByRole("button", {
        name: "Включить уведомления и звук",
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
    await page.goto("/driverProfile");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  } finally {
    await close();
  }
});

test("chat outbox reaches an offline driver with the message preview and is acknowledged", async ({
  browser,
}) => {
  const { page, send, close } = await fixture(browser);
  try {
    await spyOnBrowserNotifications(page);
    await page.goto("/driverDashboard");
    await expect(page.getByRole("group", { name: "Регионы" })).toBeVisible();
    const ack = page.waitForResponse(
      (response) =>
        response.url().endsWith("/driver/notifications/ack") &&
        response.status() === 204,
    );
    const message = await send("Пожалуйста, перезвоните диспетчеру");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __notificationBodies?: string[] })
              .__notificationBodies || [],
        ),
      )
      .toContain("Пожалуйста, перезвоните диспетчеру");
    expect((await ack).request().postDataJSON()).toEqual({
      eventId: `chat:${message.id}`,
    });
  } finally {
    await close();
  }
});

test("visible chat stays silent while the message is reconciled into the thread", async ({
  browser,
}) => {
  const { page, send, close } = await fixture(browser);
  try {
    await spyOnBrowserNotifications(page);
    await page.goto("/driverChat");
    await expect(
      page.getByRole("heading", { name: "Диспетчер" }),
    ).toBeVisible();
    await send("Сообщение без звука в открытом чате");
    await expect(
      page.getByText("Сообщение без звука в открытом чате"),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { __notificationBodies?: string[] })
              .__notificationBodies || [],
        ),
      )
      .toEqual([]);
  } finally {
    await close();
  }
});

for (const screen of ["driverMap", "driverProfile"])
  test(`dispatcher preview reaches ${screen} while shift and GPS are off`, async ({
    browser,
  }) => {
    const { page, send, close } = await fixture(browser);
    try {
      await spyOnBrowserNotifications(page);
      const ready = page.waitForResponse(
        (response) =>
          response.url().endsWith("/driver/notifications/settings") &&
          response.ok(),
      );
      await page.goto(`/${screen}`);
      await ready;
      await send(`Сообщение для ${screen}`);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { __notificationBodies?: string[] })
                .__notificationBodies || [],
          ),
        )
        .toContain(`Сообщение для ${screen}`);
    } finally {
      await close();
    }
  });

test("muted notifications preserve incoming chat history without previews", async ({
  browser,
}) => {
  const { page, send, close } = await fixture(browser);
  try {
    await spyOnBrowserNotifications(page);
    await page.goto("/driverProfile");
    const toggle = page.getByRole("switch", {
      name: "Уведомления",
      exact: true,
    });
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await send("Без уведомления, но в истории чата");
    await page.getByRole("link", { name: "Чат", exact: true }).click();
    await expect(
      page.getByText("Без уведомления, но в истории чата"),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __notificationBodies?: string[] })
            .__notificationBodies || [],
      ),
    ).toEqual([]);
  } finally {
    await close();
  }
});

async function emulateNativeNotificationTray(
  page: import("@playwright/test").Page,
  initialIds: string[] = [],
) {
  await page.addInitScript((initialIds) => {
    const bridge = window as unknown as {
      CapacitorCustomPlatform: { name: string };
      Capacitor: unknown;
      nativeChatTray: string[];
      nativeNotificationToken: string;
      nativeConfiguredTokens: string[];
      emitNativeToken: () => void;
    };
    bridge.CapacitorCustomPlatform = { name: "android" };
    bridge.nativeChatTray = [...initialIds];
    bridge.nativeNotificationToken = "";
    bridge.nativeConfiguredTokens = [];
    let tokenListener: (() => void) | undefined;
    bridge.emitNativeToken = () => tokenListener?.();
    bridge.Capacitor = {
      PluginHeaders: [
        {
          name: "DriverShift",
          methods: ["status", "permissions", "stop", "notificationTarget"].map(
            (name) => ({ name, rtype: "promise" }),
          ),
        },
        {
          name: "DriverNotifications",
          methods: [
            "status",
            "configure",
            "setPresence",
            "deliver",
            "clear",
            "reset",
            "addListener",
            "removeListener",
          ].map((name) => ({
            name,
            rtype: name === "addListener" ? "callback" : "promise",
          })),
        },
      ],
      nativePromise: async (
        _plugin: string,
        method: string,
        options?: {
          eventId?: string;
          eventIds?: string[];
          notificationToken?: string;
        },
      ) => {
        if (_plugin === "DriverShift")
          return {
            running: false,
            phase: "off",
            locationGranted: true,
            locationEnabled: true,
          };
        if (method === "status")
          return {
            permission: "granted",
            enabled: true,
            configured: true,
            token: "native-read-sync-test",
          };
        if (method === "deliver" && options?.eventId)
          bridge.nativeChatTray.push(options.eventId);
        if (method === "clear")
          bridge.nativeChatTray = options?.eventIds
            ? bridge.nativeChatTray.filter(
                (id) => !options.eventIds!.includes(id),
              )
            : [];
        if (method === "reset") bridge.nativeChatTray = [];
        if (method === "configure") {
          bridge.nativeNotificationToken = options?.notificationToken ?? "";
          bridge.nativeConfiguredTokens.push(bridge.nativeNotificationToken);
        }
        return {};
      },
      nativeCallback: (
        _plugin: string,
        method: string,
        options: { eventName?: string },
        callback: () => void,
      ) => {
        if (method === "addListener" && options.eventName === "tokenChanged")
          tokenListener = callback;
        return "notification-token-listener";
      },
    };
  }, initialIds);
}

test("reading one message on another device clears only that native alert", async ({
  browser,
}) => {
  const { page, send, markRead, close } = await fixture(browser);
  try {
    await emulateNativeNotificationTray(page);
    const registered = page.waitForResponse(
      (response) =>
        response.url().endsWith("/driver/notifications/registration") &&
        response.ok(),
    );
    await page.goto("/driverProfile");
    await registered;
    const first = await send("Первое сообщение");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { nativeChatTray: string[] }).nativeChatTray,
        ),
      )
      .toContain(`chat:${first.id}`);
    const newer = await send("Более новое непрочитанное сообщение");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { nativeChatTray: string[] }).nativeChatTray,
        ),
      )
      .toContain(`chat:${newer.id}`);
    await markRead(first.id);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { nativeChatTray: string[] }).nativeChatTray,
        ),
      )
      .toEqual([`chat:${newer.id}`]);
  } finally {
    await close();
  }
});

test("logout closes the previous driver's browser previews and removes their click actions", async ({
  browser,
}) => {
  const { page, send, close } = await fixture(browser);
  try {
    await spyOnBrowserNotifications(page);
    await page.goto("/driverProfile");
    await expect(
      page.getByRole("switch", { name: "Уведомления", exact: true }),
    ).toBeEnabled();
    await send("Личное сообщение предыдущему водителю");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __notificationTray: unknown[] })
              .__notificationTray.length,
        ),
      )
      .toBe(1);
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/\/driverLogin$/);
    expect(
      await page.evaluate(() =>
        (
          window as unknown as {
            __notificationTray: { closed: boolean; onclick: unknown }[];
          }
        ).__notificationTray.map((alert) => ({
          closed: alert.closed,
          clickable: alert.onclick !== null,
        })),
      ),
    ).toEqual([{ closed: true, clickable: false }]);
  } finally {
    await close();
  }
});

test("overlapping native token refreshes leave the installation with a working capability", async ({
  browser,
}) => {
  const { page, context, close } = await fixture(browser);
  let releaseFirst = () => {};
  try {
    await emulateNativeNotificationTray(page);
    await page.goto("/driverProfile");
    await expect(
      page.getByRole("switch", { name: "Уведомления", exact: true }),
    ).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { nativeNotificationToken: string })
              .nativeNotificationToken,
        ),
      )
      .not.toBe("");
    let notifyHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      notifyHeld = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let registrations = 0;
    let lastServerCapability = "";
    await page.route("**/driver/notifications/registration", async (route) => {
      const number = ++registrations;
      const response = await route.fetch();
      const payload = await response.json();
      lastServerCapability = payload.notificationToken;
      if (number === 1) {
        notifyHeld();
        // Give an overlapping refresh time to complete. A serialized refresh
        // instead starts after this bounded network-response delay expires.
        await Promise.race([
          released,
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
      await route.fulfill({ response });
      if (number === 2) {
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                (window as unknown as { nativeNotificationToken: string })
                  .nativeNotificationToken,
            ),
          )
          .toBe(payload.notificationToken);
        releaseFirst();
      }
    });
    await page.evaluate(() =>
      (window as unknown as { emitNativeToken: () => void }).emitNativeToken(),
    );
    await held;
    await page.evaluate(() =>
      (window as unknown as { emitNativeToken: () => void }).emitNativeToken(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { nativeConfiguredTokens: string[] })
              .nativeConfiguredTokens.length,
        ),
      )
      .toBe(3);
    const capability = await page.evaluate(
      () =>
        (window as unknown as { nativeNotificationToken: string })
          .nativeNotificationToken,
    );
    const verified = await context.request.post(
      `${process.env.TEST_API_URL}/native-notifications/event`,
      {
        headers: { Authorization: `Bearer ${capability}` },
        data: { eventId: "chat:synthetic-missing-message" },
      },
    );
    expect(verified.status()).toBe(200);
    expect(capability).toBe(lastServerCapability);
  } finally {
    releaseFirst();
    await close();
  }
});

test("muting notifications survives a delayed native token registration", async ({
  browser,
}) => {
  const { page, settings, close } = await fixture(browser);
  let releaseRegistration = () => {};
  try {
    await emulateNativeNotificationTray(page);
    await page.goto("/driverProfile");
    const toggle = page.getByRole("switch", {
      name: "Уведомления",
      exact: true,
    });
    await expect(toggle).toBeEnabled();
    let notifyHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      notifyHeld = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    await page.route("**/driver/notifications/registration", async (route) => {
      notifyHeld();
      await released;
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    await page.evaluate(() =>
      (window as unknown as { emitNativeToken: () => void }).emitNativeToken(),
    );
    await held;
    const muted = page.waitForResponse(
      (response) =>
        response.url().endsWith("/driver/notifications/settings") &&
        response.request().method() === "POST" &&
        response.ok(),
    );
    await toggle.click();
    // The user's mute command is queued behind registration, if necessary.
    await Promise.race([
      muted,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    releaseRegistration();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toBeEnabled();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { nativeConfiguredTokens: string[] })
              .nativeConfiguredTokens.length,
        ),
      )
      .toBe(2);
    await expect.poll(async () => (await settings()).enabled).toBe(false);
  } finally {
    releaseRegistration();
    await close();
  }
});

test("recovering the same native account keeps its delivered notification ledger", async ({
  browser,
}) => {
  const { page, close } = await fixture(browser);
  try {
    await emulateNativeNotificationTray(page, ["chat:already-delivered"]);
    const registered = page.waitForResponse(
      (response) =>
        response.url().endsWith("/driver/notifications/registration") &&
        response.ok(),
    );
    await page.goto("/driverProfile");
    await registered;
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { nativeChatTray: string[] }).nativeChatTray,
        ),
      )
      .toEqual(["chat:already-delivered"]);
  } finally {
    await close();
  }
});
