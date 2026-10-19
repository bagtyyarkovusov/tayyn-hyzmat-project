import { test, expect, type Browser, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { loginFixture, installFixtureSession } from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");

const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");

async function fixture(browser: Browser, name = "Водитель оповещений") {
  const prisma = new PrismaClient();
  const admin = await prisma.user.findUniqueOrThrow({
    where: { phone: "+99360000000" },
  });
  const user = await prisma.user.create({
    data: {
      phone: `+993${String(Date.now()).slice(-8)}`,
      fullName: name,
      role: "DRIVER",
      passwordHash: admin.passwordHash,
      balance: { create: { amount: 500 } },
      driver: { create: { status: "APPROVED" } },
    },
    include: { driver: true },
  });
  const driverContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const secondAdminContext = await browser.newContext();
  for (const context of [adminContext, secondAdminContext]) {
    await context.addInitScript(() => {
      const probe = {
        plays: [] as Array<{
          source: string;
          volume: number;
          loop: boolean;
          at: number;
        }>,
        active: new Set<HTMLMediaElement>(),
        rejectPlayback: false,
      };
      Object.assign(window, { __adminSound: probe });
      // Audio is the external boundary. HTTP, sockets, read cursors and tabs are real.
      HTMLMediaElement.prototype.play = function () {
        if (probe.rejectPlayback)
          return Promise.reject(
            new DOMException("Autoplay denied", "NotAllowedError"),
          );
        probe.plays.push({
          source: new URL(this.src).pathname,
          volume: this.volume,
          loop: this.loop,
          at: Date.now(),
        });
        probe.active.add(this);
        return Promise.resolve();
      };
      HTMLMediaElement.prototype.pause = function () {
        probe.active.delete(this);
      };
    });
  }
  const driverSession = await loginFixture(
    driverContext.request,
    user.phone,
    `admin-alert-driver-${user.id}`,
  );
  const adminSession = await loginFixture(adminContext.request, admin.phone);
  const secondAdminSession = await loginFixture(
    secondAdminContext.request,
    admin.phone,
    "admin-alert-second-tab",
  );
  await installFixtureSession(
    driverContext,
    "driver",
    driverSession,
    `admin-alert-driver-${user.id}`,
  );
  await installFixtureSession(adminContext, "admin", adminSession);
  await installFixtureSession(secondAdminContext, "admin", secondAdminSession);
  const send = async (body: string) => {
    const response = await driverContext.request.post(
      `${process.env.TEST_API_URL}/driver/messages`,
      {
        headers: { Authorization: `Bearer ${driverSession.accessToken}` },
        data: { body, clientMessageId: crypto.randomUUID() },
      },
    );
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const orderIds: string[] = [];
  const adminPost = async (path: string, data: object = {}) => {
    const response = await adminContext.request.post(
      `${process.env.TEST_API_URL}${path}`,
      {
        headers: { Authorization: `Bearer ${adminSession.accessToken}` },
        data,
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const driverPost = async (path: string, data: object) => {
    const response = await driverContext.request.post(
      `${process.env.TEST_API_URL}${path}`,
      {
        headers: { Authorization: `Bearer ${driverSession.accessToken}` },
        data,
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  return {
    adminPost,
    recancelOrder: async (orderId: string) => {
      await driverPost("/orders/accept", { orderId });
      await driverPost("/orders/cancel", { orderId });
    },
    cancelOrder: async () => {
      await driverPost("/driver/status", {
        isOnline: true,
        isAvailable: true,
        position: {
          lat: 37.96,
          lng: 58.32,
          accuracy: 10,
          capturedAt: Date.now(),
        },
      });
      const order = await adminPost("/admin/orders", {
        districtId: process.env.TEST_REGION_ID,
        clientPhone: "+99365999999",
        priceEstimated: 25,
        pickupAddress: "Торговый центр, главный вход",
      });
      orderIds.push(order.id);
      await driverPost("/orders/accept", { orderId: order.id });
      await driverPost("/orders/cancel", { orderId: order.id });
      return order;
    },
    adminPage: await adminContext.newPage(),
    secondAdminPage: await secondAdminContext.newPage(),
    sameBrowserPage: await adminContext.newPage(),
    send,
    markRead: async (throughMessageId: string) => {
      const response = await adminContext.request.post(
        `${process.env.TEST_API_URL}/admin/drivers/${user.driver.id}/messages/read`,
        {
          headers: { Authorization: `Bearer ${adminSession.accessToken}` },
          data: { throughMessageId },
        },
      );
      expect(response.ok()).toBe(true);
    },
    driverId: user.driver.id,
    close: async () => {
      await driverContext.close();
      await adminContext.close();
      await secondAdminContext.close();
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.$disconnect();
    },
  };
}

test("driver messages alert every admin tab outside the active conversation", async ({
  browser,
}) => {
  const { adminPage, secondAdminPage, send, close } = await fixture(browser);
  try {
    await adminPage.goto("/adminDashboard");
    await secondAdminPage.goto("/adminDashboard");
    await expect(
      adminPage.getByRole("heading", { name: "Обзор" }),
    ).toBeVisible();
    await expect(
      secondAdminPage.getByRole("heading", { name: "Обзор" }),
    ).toBeVisible();

    await send("Нужна помощь на маршруте");

    for (const page of [adminPage, secondAdminPage]) {
      const alert = page.getByRole("alert", { name: "Новое сообщение" });
      await expect(alert).toContainText("Водитель оповещений");
      await expect(alert).toContainText("Нужна помощь на маршруте");
      await expect(alert).toContainText("1 непрочитанных");
    }

    // The shared read cursor clears the banner in every other dispatcher tab.
    await secondAdminPage
      .getByRole("button", { name: /Водитель оповещений/ })
      .click();
    await expect(
      secondAdminPage.getByRole("heading", { name: "Водитель оповещений" }),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("alert", { name: "Новое сообщение" }),
    ).toHaveCount(0);
  } finally {
    await close();
  }
});

test("active admin conversation stays quiet for an incoming driver message", async ({
  browser,
}) => {
  const { adminPage, send, driverId, close } = await fixture(browser);
  try {
    await adminPage.goto(`/adminChat/${driverId}`);
    await expect(
      adminPage.getByRole("heading", { name: "Водитель оповещений" }),
    ).toBeVisible();
    await send("Сообщение в открытом диалоге");
    await expect(
      adminPage.getByText("Сообщение в открытом диалоге"),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("alert", { name: "Новое сообщение" }),
    ).toHaveCount(0);
    expect((await sound(adminPage)).plays).toHaveLength(0);
  } finally {
    await close();
  }
});

test("a delayed unread snapshot cannot erase a newer live admin message", async ({
  browser,
}) => {
  const { adminPage, send, close } = await fixture(browser);
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let capturedSnapshot!: () => void;
  const captured = new Promise<void>((resolve) => {
    capturedSnapshot = resolve;
  });
  let snapshotDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => {
    snapshotDelivered = resolve;
  });
  let intercepted = false;
  await adminPage.route("**/admin/messages/unread", async (route) => {
    if (intercepted) return route.continue();
    intercepted = true;
    const response = await route.fetch();
    capturedSnapshot();
    await snapshotGate;
    await route.fulfill({ response });
    snapshotDelivered();
  });
  try {
    await adminPage.goto("/adminDashboard");
    await captured;
    await send("Новое сообщение после снимка");
    const alert = adminPage.getByRole("alert", { name: "Новое сообщение" });
    await expect(alert).toContainText("Новое сообщение после снимка");
    releaseSnapshot();
    await delivered;
    await adminPage.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(alert).toContainText("1 непрочитанных");
  } finally {
    releaseSnapshot();
    await close();
  }
});

test("reading an older driver message keeps the newer admin alert", async ({
  browser,
}) => {
  const { adminPage, send, markRead, close } = await fixture(browser);
  try {
    await adminPage.goto("/adminDashboard");
    await expect(
      adminPage.getByRole("heading", { name: "Обзор" }),
    ).toBeVisible();
    const older = await send("Предыдущее сообщение водителя");
    await send("Последнее непрочитанное сообщение");
    const alert = adminPage.getByRole("alert", { name: "Новое сообщение" });
    await expect(alert).toContainText("Последнее непрочитанное сообщение");
    const reconciliation = adminPage.waitForRequest((request) =>
      request.url().endsWith("/admin/messages/unread"),
    );
    await markRead(older.id);
    const response = await (await reconciliation).response();
    expect(response?.ok()).toBe(true);
    await adminPage.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await expect(alert).toContainText("Последнее непрочитанное сообщение");
    await expect(alert).toContainText("1 непрочитанных");
  } finally {
    await close();
  }
});

async function sound(page: Page) {
  return page.evaluate(() => {
    const probe = (
      window as unknown as {
        __adminSound: {
          plays: Array<{
            source: string;
            volume: number;
            loop: boolean;
            at: number;
          }>;
          active: Set<HTMLMediaElement>;
        };
      }
    ).__adminSound;
    return { plays: probe.plays, active: probe.active.size };
  });
}

async function dashboard(page: Page) {
  await page.goto("/adminDashboard");
  await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
}

test("admin chat uses a dedicated subsecond chime once per browser during a burst", async ({
  browser,
}) => {
  const { adminPage, sameBrowserPage, secondAdminPage, send, close } =
    await fixture(browser);
  try {
    await Promise.all(
      [adminPage, sameBrowserPage, secondAdminPage].map(dashboard),
    );
    await send("Первое короткое оповещение");
    for (const page of [adminPage, sameBrowserPage, secondAdminPage])
      await expect(
        page.getByRole("alert", { name: "Новое сообщение" }),
      ).toContainText("Первое короткое оповещение");
    await expect
      .poll(
        async () =>
          (await sound(adminPage)).plays.length +
          (await sound(sameBrowserPage)).plays.length,
      )
      .toBe(1);
    await expect
      .poll(async () => (await sound(secondAdminPage)).plays.length)
      .toBe(1);
    const records = [
      ...(await sound(adminPage)).plays,
      ...(await sound(sameBrowserPage)).plays,
      ...(await sound(secondAdminPage)).plays,
    ];
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.source).toBe("/sounds/admin-chat-chime.wav");
      expect(record.volume).toBeLessThanOrEqual(0.3);
      expect(record.loop).toBe(false);
    }
    await send("Второе сообщение без второго звука");
    for (const page of [adminPage, sameBrowserPage, secondAdminPage])
      await expect(
        page.getByRole("alert", { name: "Новое сообщение" }),
      ).toContainText("Второе сообщение без второго звука");
    expect(
      (await sound(adminPage)).plays.length +
        (await sound(sameBrowserPage)).plays.length,
    ).toBe(1);
    expect((await sound(secondAdminPage)).plays).toHaveLength(1);
    await expect
      .poll(
        async () =>
          (await sound(adminPage)).active +
          (await sound(sameBrowserPage)).active +
          (await sound(secondAdminPage)).active,
      )
      .toBe(0);

    const duration = await adminPage.evaluate(async () => {
      const asset = new Audio("/sounds/admin-chat-chime.wav");
      return new Promise<number>((resolve, reject) => {
        asset.onloadedmetadata = () => resolve(asset.duration);
        asset.onerror = () =>
          reject(new Error("Dedicated chat chime did not load"));
        asset.load();
      });
    });
    expect(duration).toBeGreaterThan(0.1);
    expect(duration).toBeLessThan(1);
    await new Promise((resolve) => setTimeout(resolve, 3_050));
    await send("Новое оповещение после паузы");
    await expect
      .poll(
        async () =>
          (await sound(adminPage)).plays.length +
          (await sound(sameBrowserPage)).plays.length,
      )
      .toBe(2);
    await expect
      .poll(async () => (await sound(secondAdminPage)).plays.length)
      .toBe(2);
  } finally {
    await close();
  }
});

test("admin chat sound stops when its banner is dismissed or its conversation opens", async ({
  browser,
}) => {
  const { adminPage, secondAdminPage, send, close } = await fixture(browser);
  try {
    await Promise.all([adminPage, secondAdminPage].map(dashboard));
    await send("Закрыть короткий звук");
    await expect.poll(async () => (await sound(adminPage)).active).toBe(1);
    await adminPage
      .getByRole("button", { name: "Закрыть уведомление" })
      .click();
    expect((await sound(adminPage)).active).toBe(0);
    await secondAdminPage
      .getByRole("button", { name: /Водитель оповещений/ })
      .click();
    expect((await sound(secondAdminPage)).active).toBe(0);
  } finally {
    await close();
  }
});

test("shared read stops the corresponding sound in every browser", async ({
  browser,
}) => {
  const { adminPage, secondAdminPage, send, markRead, close } =
    await fixture(browser);
  try {
    await Promise.all([adminPage, secondAdminPage].map(dashboard));
    const message = await send("Прочитать и убрать звук");
    await expect.poll(async () => (await sound(adminPage)).active).toBe(1);
    await markRead(message.id);
    await expect(
      adminPage.getByRole("alert", { name: "Новое сообщение" }),
    ).toHaveCount(0);
    expect((await sound(adminPage)).active).toBe(0);
    expect((await sound(secondAdminPage)).active).toBe(0);
  } finally {
    await close();
  }
});

test("a hidden admin conversation alerts and becomes quiet when visible again", async ({
  browser,
}) => {
  const { adminPage, send, driverId, close } = await fixture(browser);
  try {
    await adminPage.goto(`/adminChat/${driverId}`);
    await expect(
      adminPage.getByRole("heading", { name: "Водитель оповещений" }),
    ).toBeVisible();
    await adminPage.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await send("Сообщение в скрытой вкладке");
    await expect(
      adminPage.getByRole("alert", { name: "Новое сообщение" }),
    ).toContainText("Сообщение в скрытой вкладке");
    await expect
      .poll(async () => (await sound(adminPage)).plays.length)
      .toBe(1);
    await adminPage.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(
      adminPage.getByRole("alert", { name: "Новое сообщение" }),
    ).toHaveCount(0);
    expect((await sound(adminPage)).active).toBe(0);
  } finally {
    await close();
  }
});

test("dismissing the silent tab also stops the audible tab without marking the chat read", async ({
  browser,
}) => {
  const { adminPage, sameBrowserPage, send, close } = await fixture(browser);
  try {
    await Promise.all([adminPage, sameBrowserPage].map(dashboard));
    await send("Убрать звук во всех вкладках");
    await expect
      .poll(
        async () =>
          (await sound(adminPage)).active +
          (await sound(sameBrowserPage)).active,
      )
      .toBe(1);
    const audible = (await sound(adminPage)).active
      ? adminPage
      : sameBrowserPage;
    const silent = audible === adminPage ? sameBrowserPage : adminPage;
    await silent.getByRole("button", { name: "Закрыть уведомление" }).click();
    await expect.poll(async () => (await sound(audible)).active).toBe(0);
    await expect(
      audible.getByRole("alert", { name: "Новое сообщение" }),
    ).toContainText("Убрать звук во всех вкладках");
    await expect(
      audible.getByRole("alert", { name: "Новое сообщение" }),
    ).toContainText("1 непрочитанных");
  } finally {
    await close();
  }
});

test("leaving the admin shell stops an already playing chat chime", async ({
  browser,
}) => {
  const { adminPage, send, close } = await fixture(browser);
  try {
    await dashboard(adminPage);
    await send("Выйти и остановить звук");
    await expect.poll(async () => (await sound(adminPage)).active).toBe(1);
    await adminPage.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(adminPage).toHaveURL(/adminLogin/);
    expect((await sound(adminPage)).active).toBe(0);
  } finally {
    await close();
  }
});

for (const action of ["dismiss", "open", "read", "logout"] as const) {
  test(`a pending browser sound cannot start after ${action}`, async ({
    browser,
  }) => {
    const { adminPage, send, markRead, close } = await fixture(browser);
    try {
      await dashboard(adminPage);
      // Hold the real browser coordination lock so the incoming chime waits.
      await adminPage.evaluate(() => {
        const admin = JSON.parse(localStorage.getItem("tayyn.admin.user")!);
        void navigator.locks.request(
          `tayyn.admin.chat-sound.${admin.id}`,
          async () => {
            await new Promise<void>((release) =>
              Object.assign(window, { __releaseAdminSoundLock: release }),
            );
          },
        );
      });
      await expect
        .poll(() =>
          adminPage.evaluate(() =>
            Boolean(
              (window as unknown as { __releaseAdminSoundLock?: () => void })
                .__releaseAdminSoundLock,
            ),
          ),
        )
        .toBe(true);
      const message = await send("Ожидающий звук не должен вернуться");
      await expect(
        adminPage.getByRole("alert", { name: "Новое сообщение" }),
      ).toBeVisible();
      if (action === "dismiss")
        await adminPage
          .getByRole("button", { name: "Закрыть уведомление" })
          .click();
      if (action === "open")
        await adminPage
          .getByRole("button", { name: /Водитель оповещений/ })
          .click();
      if (action === "read") {
        await markRead(message.id);
        await expect(
          adminPage.getByRole("alert", { name: "Новое сообщение" }),
        ).toHaveCount(0);
      }
      if (action === "logout")
        await adminPage
          .getByRole("button", { name: "Выйти", exact: true })
          .click();
      await adminPage.evaluate(() =>
        (
          window as unknown as { __releaseAdminSoundLock: () => void }
        ).__releaseAdminSoundLock(),
      );
      await expect
        .poll(() =>
          adminPage.evaluate(
            async () => (await navigator.locks.query()).pending?.length ?? 0,
          ),
        )
        .toBe(0);
      expect((await sound(adminPage)).plays).toHaveLength(0);
    } finally {
      await close();
    }
  });
}

test("reconnecting the dashboard restores unread state without replaying its sound", async ({
  browser,
}) => {
  const { adminPage, send, close } = await fixture(browser);
  try {
    await dashboard(adminPage);
    await send("Сохранённое непрочитанное сообщение");
    await expect
      .poll(async () => (await sound(adminPage)).plays.length)
      .toBe(1);
    await adminPage.context().setOffline(true);
    await new Promise((resolve) => setTimeout(resolve, 3_050));
    const reconciled = adminPage.waitForResponse(
      (response) =>
        response.url().endsWith("/admin/messages/unread") && response.ok(),
    );
    await adminPage.context().setOffline(false);
    await reconciled;
    expect((await sound(adminPage)).plays).toHaveLength(1);
    await adminPage.reload();
    await expect(
      adminPage.getByRole("heading", { name: "Обзор" }),
    ).toBeVisible();
    expect((await sound(adminPage)).plays).toHaveLength(0);
  } finally {
    await close();
  }
});

test("a burst replaces the preview and silences its previous chime before dismissal", async ({
  browser,
}) => {
  const { adminPage, send, close } = await fixture(browser);
  try {
    await dashboard(adminPage);
    await adminPage.clock.pauseAt(Date.now());
    await send("Первое сообщение со звуком");
    await expect.poll(async () => (await sound(adminPage)).active).toBe(1);
    await send("Новый текст во время паузы");
    await expect(
      adminPage.getByRole("alert", { name: "Новое сообщение" }),
    ).toContainText("Новый текст во время паузы");
    expect((await sound(adminPage)).plays).toHaveLength(1);
    expect((await sound(adminPage)).active).toBe(0);
    await adminPage
      .getByRole("button", { name: "Закрыть уведомление" })
      .click();
    expect((await sound(adminPage)).active).toBe(0);
  } finally {
    await close();
  }
});

test("an older read cursor cannot silence the newer unread message", async ({
  browser,
}) => {
  const { adminPage, send, markRead, close } = await fixture(browser);
  try {
    await dashboard(adminPage);
    const older = await send("Предыдущий прочитанный текст");
    await expect
      .poll(async () => (await sound(adminPage)).plays.length)
      .toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 3_050));
    await adminPage.clock.pauseAt(Date.now());
    const newer = await send("Новый непрочитанный текст со звуком");
    await expect.poll(async () => (await sound(adminPage)).active).toBe(1);
    const reconciled = adminPage.waitForResponse(
      (response) =>
        response.url().endsWith("/admin/messages/unread") && response.ok(),
    );
    await markRead(older.id);
    await reconciled;
    expect((await sound(adminPage)).active).toBe(1);
    await expect(
      adminPage.getByRole("alert", { name: "Новое сообщение" }),
    ).toContainText("Новый непрочитанный текст со звуком");
    await markRead(newer.id);
    await expect.poll(async () => (await sound(adminPage)).active).toBe(0);
  } finally {
    await close();
  }
});

for (const failure of ["locks", "storage", "autoplay"] as const) {
  test(`admin chat keeps its visible alert when ${failure} is unavailable`, async ({
    browser,
  }) => {
    const { adminPage, send, close } = await fixture(browser);
    try {
      await dashboard(adminPage);
      await adminPage.evaluate((failure) => {
        if (failure === "locks")
          Object.defineProperty(navigator, "locks", {
            configurable: true,
            value: undefined,
          });
        if (failure === "storage") {
          const original = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            if (key.startsWith("tayyn.admin.chat-sound."))
              throw new DOMException("Storage denied", "SecurityError");
            return original.call(this, key, value);
          };
        }
        if (failure === "autoplay")
          (
            window as unknown as { __adminSound: { rejectPlayback: boolean } }
          ).__adminSound.rejectPlayback = true;
      }, failure);
      await send("Видимое сообщение без звука");
      await expect(
        adminPage.getByRole("alert", { name: "Новое сообщение" }),
      ).toContainText("Видимое сообщение без звука");
      expect((await sound(adminPage)).plays).toHaveLength(0);
      expect((await sound(adminPage)).active).toBe(0);
    } finally {
      await close();
    }
  });
}

test("cross-tab dismissal cancels a chime still waiting for the browser lock", async ({
  browser,
}) => {
  const { adminPage, sameBrowserPage, send, close } = await fixture(browser);
  try {
    await Promise.all([adminPage, sameBrowserPage].map(dashboard));
    await adminPage.evaluate(() => {
      const admin = JSON.parse(localStorage.getItem("tayyn.admin.user")!);
      void navigator.locks.request(
        `tayyn.admin.chat-sound.${admin.id}`,
        async () => {
          await new Promise<void>((release) =>
            Object.assign(window, { __releaseAdminSoundLock: release }),
          );
        },
      );
    });
    await expect
      .poll(() =>
        adminPage.evaluate(() =>
          Boolean(
            (window as unknown as { __releaseAdminSoundLock?: () => void })
              .__releaseAdminSoundLock,
          ),
        ),
      )
      .toBe(true);
    await send("Закрыть ожидающий звук из другой вкладки");
    for (const page of [adminPage, sameBrowserPage])
      await expect(
        page.getByRole("alert", { name: "Новое сообщение" }),
      ).toBeVisible();
    await sameBrowserPage
      .getByRole("button", { name: "Закрыть уведомление" })
      .click();
    await adminPage.evaluate(() =>
      (
        window as unknown as { __releaseAdminSoundLock: () => void }
      ).__releaseAdminSoundLock(),
    );
    await expect
      .poll(() =>
        adminPage.evaluate(
          async () => (await navigator.locks.query()).pending?.length ?? 0,
        ),
      )
      .toBe(0);
    expect((await sound(adminPage)).plays).toHaveLength(0);
    expect((await sound(sameBrowserPage)).plays).toHaveLength(0);
    await expect(
      adminPage.getByRole("alert", { name: "Новое сообщение" }),
    ).toContainText("Закрыть ожидающий звук из другой вкладки");
  } finally {
    await close();
  }
});

test("logging out a silent tab stops that message's sound in another tab without reading it", async ({
  browser,
}) => {
  const { adminPage, sameBrowserPage, send, close } = await fixture(browser);
  let releaseLogout = () => {};
  try {
    await Promise.all([adminPage, sameBrowserPage].map(dashboard));
    const now = Date.now();
    await Promise.all([
      adminPage.clock.pauseAt(now),
      sameBrowserPage.clock.pauseAt(now),
    ]);
    await send("Выйти из тихой вкладки");
    await expect
      .poll(
        async () =>
          (await sound(adminPage)).active +
          (await sound(sameBrowserPage)).active,
      )
      .toBe(1);
    const audible = (await sound(adminPage)).active
      ? adminPage
      : sameBrowserPage;
    const silent = audible === adminPage ? sameBrowserPage : adminPage;
    releaseLogout = await delayLogout(silent);
    await silent.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(silent).toHaveURL(/adminLogin/);
    await expect.poll(async () => (await sound(audible)).active).toBe(0);
    await expect(
      audible.getByRole("alert", { name: "Новое сообщение" }),
    ).toContainText("Выйти из тихой вкладки");
    await expect(
      audible.getByRole("alert", { name: "Новое сообщение" }),
    ).toContainText("1 непрочитанных");
  } finally {
    releaseLogout();
    await close();
  }
});

test("logging out one tab cancels that message's pending sound in another tab", async ({
  browser,
}) => {
  const { adminPage, sameBrowserPage, send, close } = await fixture(browser);
  let releaseLogout = () => {};
  try {
    await Promise.all([adminPage, sameBrowserPage].map(dashboard));
    await adminPage.evaluate(() => {
      const admin = JSON.parse(localStorage.getItem("tayyn.admin.user")!);
      void navigator.locks.request(
        `tayyn.admin.chat-sound.${admin.id}`,
        async () => {
          await new Promise<void>((release) =>
            Object.assign(window, { __releaseAdminSoundLock: release }),
          );
        },
      );
    });
    await expect
      .poll(() =>
        adminPage.evaluate(() =>
          Boolean(
            (window as unknown as { __releaseAdminSoundLock?: () => void })
              .__releaseAdminSoundLock,
          ),
        ),
      )
      .toBe(true);
    await send("Ожидающий звук после выхода из другой вкладки");
    for (const page of [adminPage, sameBrowserPage])
      await expect(
        page.getByRole("alert", { name: "Новое сообщение" }),
      ).toBeVisible();
    releaseLogout = await delayLogout(sameBrowserPage);
    await sameBrowserPage
      .getByRole("button", { name: "Выйти", exact: true })
      .click();
    await expect(sameBrowserPage).toHaveURL(/adminLogin/);
    await adminPage.evaluate(() =>
      (
        window as unknown as { __releaseAdminSoundLock: () => void }
      ).__releaseAdminSoundLock(),
    );
    await expect
      .poll(() =>
        adminPage.evaluate(
          async () => (await navigator.locks.query()).pending?.length ?? 0,
        ),
      )
      .toBe(0);
    expect((await sound(adminPage)).plays).toHaveLength(0);
    await expect(
      adminPage.getByRole("alert", { name: "Новое сообщение" }),
    ).toContainText("Ожидающий звук после выхода из другой вкладки");
  } finally {
    releaseLogout();
    await close();
  }
});

async function delayLogout(page: Page) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Keep the real request pending while checking local shell teardown. The
  // existing server-wide admin logout must not hide missing tab cleanup.
  await page.route("**/auth/logout", async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  return release;
}

test("unmounting a silent dashboard tab silences its preview without signing out the other tab", async ({
  browser,
}) => {
  const { adminPage, sameBrowserPage, send, close } = await fixture(browser);
  try {
    await Promise.all([adminPage, sameBrowserPage].map(dashboard));
    const now = Date.now();
    await Promise.all([
      adminPage.clock.pauseAt(now),
      sameBrowserPage.clock.pauseAt(now),
    ]);
    await send("Покинуть экран и убрать только звук");
    await expect
      .poll(
        async () =>
          (await sound(adminPage)).active +
          (await sound(sameBrowserPage)).active,
      )
      .toBe(1);
    const audible = (await sound(adminPage)).active
      ? adminPage
      : sameBrowserPage;
    const silent = audible === adminPage ? sameBrowserPage : adminPage;
    // Public browser-history navigation makes the SPA leave its dashboard
    // shell without changing credentials or issuing a logout/read command.
    await silent.evaluate(() => {
      history.pushState(null, "", "/adminLogin");
      dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
    });
    await expect(
      silent.getByRole("alert", { name: "Новое сообщение" }),
    ).toHaveCount(0);
    await expect.poll(async () => (await sound(audible)).active).toBe(0);
    await expect(
      audible.getByRole("alert", { name: "Новое сообщение" }),
    ).toContainText("Покинуть экран и убрать только звук");
    await expect(audible.getByRole("heading", { name: "Обзор" })).toBeVisible();
    const unread = await audible.evaluate(async () => {
      const response = await fetch("/api/admin/messages/unread", {
        headers: {
          Authorization: `Bearer ${localStorage.getItem("openride.admin.accessToken")}`,
        },
      });
      return { status: response.status, body: await response.json() };
    });
    expect(unread.status).toBe(200);
    expect(unread.body.driverIds).not.toHaveLength(0);
  } finally {
    await close();
  }
});

test("unread driver rows survive other messages and silent reconnect recovery", async ({
  browser,
}) => {
  const first = await fixture(browser, "Первый водитель");
  const second = await fixture(browser, "Второй водитель");
  try {
    await dashboard(first.adminPage);
    await first.send("Первый запрос помощи");
    await second.send("Второй запрос помощи");
    const alert = first.adminPage.getByRole("alert", {
      name: "Новое сообщение",
    });
    await expect(
      alert.getByRole("button", { name: /Первый водитель/ }),
    ).toBeVisible();
    await expect(
      alert.getByRole("button", { name: /Второй водитель/ }),
    ).toBeVisible();
    await first.send("Уточнение первого водителя");
    await expect(alert).toContainText("Уточнение первого водителя");
    await expect(alert).toContainText("Второй запрос помощи");
    await alert
      .getByRole("listitem")
      .filter({ hasText: "Первый водитель" })
      .getByRole("button", { name: "Закрыть уведомление" })
      .click();
    await expect(alert).not.toContainText("Первый водитель");
    await expect(alert).toContainText("Второй водитель");
    await first.adminPage.reload();
    await expect(alert).toContainText("Первый водитель");
    await expect(alert).toContainText("Второй водитель");
    expect((await sound(first.adminPage)).plays).toHaveLength(0);
    await alert
      .getByRole("button", { name: /Второй водитель.*Второй запрос помощи/ })
      .click();
    await expect(alert).not.toContainText("Второй водитель");
    await expect(alert).toContainText("Первый водитель");
  } finally {
    await first.close();
    await second.close();
  }
});

test("cancellation alerts use a distinct chime after chat without overlap or recovery replay", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    await Promise.all([f.adminPage, f.sameBrowserPage].map(dashboard));
    await f.send("Вопрос диспетчеру");
    await expect
      .poll(
        async () =>
          (await sound(f.adminPage)).plays.length +
          (await sound(f.sameBrowserPage)).plays.length,
      )
      .toBe(1);
    const order = await f.cancelOrder();
    const banner = f.adminPage.getByRole("region", {
      name: "Отмены требуют решения",
      exact: true,
    });
    await expect(banner).toContainText(`Заказ #${order.orderNumber}`);
    await expect
      .poll(
        async () =>
          [
            ...(await sound(f.adminPage)).plays,
            ...(await sound(f.sameBrowserPage)).plays,
          ].filter((p) => p.source === "/sounds/admin-cancellation-chime.wav")
            .length,
      )
      .toBe(1);
    const plays = [
      ...(await sound(f.adminPage)).plays,
      ...(await sound(f.sameBrowserPage)).plays,
    ].sort((a, b) => a.at - b.at);
    expect(plays[1].at - plays[0].at).toBeGreaterThanOrEqual(750);
    await f.adminPage
      .getByRole("link", { name: "Активность", exact: true })
      .click();
    expect([
      ...(await sound(f.adminPage)).plays,
      ...(await sound(f.sameBrowserPage)).plays,
    ]).toHaveLength(2);
    await f.adminPage.reload();
    await expect(banner).toContainText(`Заказ #${order.orderNumber}`);
    expect((await sound(f.adminPage)).plays).toHaveLength(0);
    await f.adminPost(`/admin/orders/${order.id}/reoffer`);
    await expect(banner).toHaveCount(0);
  } finally {
    await f.close();
  }
});

test("Activity refreshes when an order is cancelled and reoffered while open", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    await f.adminPage.goto("/adminReports");
    await expect(
      f.adminPage.getByRole("heading", { name: "Активность", exact: true }),
    ).toBeVisible();
    const order = await f.cancelOrder();
    const row = f.adminPage
      .locator("main")
      .getByRole("listitem")
      .filter({ hasText: `#${order.orderNumber}` });
    await expect(row).toContainText("Отменён заказ");
    await f.adminPost(`/admin/orders/${order.id}/reoffer`);
    await expect(row).toHaveCount(2);
    await expect(
      row.filter({ hasText: "Повторно предложен заказ" }),
    ).toBeVisible();
    await expect(
      row.getByRole("link", {
        name: `Заказ #${order.orderNumber}`,
        exact: true,
      }),
    ).toHaveCount(2);
  } finally {
    await f.close();
  }
});

test("Activity retains order decisions with actor, time and order links", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    const order = await f.cancelOrder();
    await f.adminPost(`/admin/orders/${order.id}/reoffer`);
    await f.adminPage.goto("/adminReports");
    await expect(
      f.adminPage.getByRole("heading", { name: "Активность", exact: true }),
    ).toBeVisible();
    const rows = f.adminPage
      .getByRole("listitem")
      .filter({ hasText: `#${order.orderNumber}` });
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: "Отменён заказ" })).toContainText(
      "Водитель оповещений",
    );
    await expect(
      rows.getByRole("link", {
        name: `Заказ #${order.orderNumber}`,
        exact: true,
      }),
    ).toHaveCount(2);
    for (const row of await rows.all())
      await expect(row.locator("time")).toHaveAttribute("datetime", /T/);
    await f.adminPage.reload();
    await expect(rows).toHaveCount(2);
    await rows
      .filter({ hasText: "Отменён заказ" })
      .getByRole("link", { name: `Заказ #${order.orderNumber}`, exact: true })
      .click();
    await expect(f.adminPage).toHaveURL(
      new RegExp(`status=all.*orderNumber=${order.orderNumber}`),
    );
    await expect(
      f.adminPage
        .getByRole("article")
        .filter({ hasText: `#${order.orderNumber}` }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test("four cancellations and conversations stay bounded without covering the shell", async ({
  browser,
}) => {
  const fixtures = [];
  try {
    for (const name of [
      "Первый водитель",
      "Второй водитель",
      "Третий водитель",
      "Четвёртый водитель",
    ])
      fixtures.push(await fixture(browser, name));
    const f = fixtures[0];
    await dashboard(f.adminPage);
    const orders = [];
    for (const driver of fixtures) {
      orders.push(await driver.cancelOrder());
      await driver.send(
        "Нужна помощь у главного входа, пассажир с большим чемоданом",
      );
    }
    const cancellations = f.adminPage.getByRole("region", {
      name: "Отмены требуют решения",
      exact: true,
    });
    const messages = f.adminPage.getByRole("alert", {
      name: "Новое сообщение",
    });
    await expect(cancellations.getByRole("listitem")).toHaveCount(3);
    await expect(messages.getByRole("listitem")).toHaveCount(3);
    await expect(
      cancellations.getByRole("link", { name: "Все отмены · 4" }),
    ).toHaveAttribute("href", "/adminOrders?status=cancelled");
    await expect(
      messages.getByRole("link", { name: "Все сообщения · 4" }),
    ).toHaveAttribute("href", "/adminChat");
    const assertLayout = async () => {
      const header = await f.adminPage
        .locator(".workspace-header")
        .boundingBox();
      const alerts = await f.adminPage
        .locator(".dispatcher-alerts")
        .boundingBox();
      expect(alerts!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
      expect(
        await f.adminPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      for (const close of await messages
        .getByRole("button", { name: "Закрыть уведомление" })
        .all()) {
        const box = await close.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
      }
    };
    await assertLayout();
    await f.adminPage.screenshot({
      path: ".local/dispatcher-alerts-validation/desktop-four-alerts.png",
      fullPage: true,
    });
    await f.adminPage.setViewportSize({ width: 390, height: 844 });
    await f.adminPage.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.style.fontSize = "125%";
    });
    await assertLayout();
    await f.adminPage.screenshot({
      path: ".local/dispatcher-alerts-validation/mobile-dark-large-text.png",
      fullPage: true,
    });
    await f.adminPost(`/admin/orders/${orders[0].id}/final-cancel`);
    await expect(cancellations).toContainText("Отмены требуют решения · 3");
    await expect(cancellations.getByRole("listitem")).toHaveCount(3);
    await expect(messages.getByRole("listitem")).toHaveCount(3);
    await f.adminPage
      .getByRole("link", { name: "Активность", exact: true })
      .click();
    await expect(cancellations).toContainText("Отмены требуют решения · 3");
    await expect(messages.getByRole("listitem")).toHaveCount(3);
    await messages.getByRole("link", { name: "Все сообщения · 4" }).click();
    await expect(f.adminPage).toHaveURL(/adminChat$/);
    await expect(
      f.adminPage.getByRole("heading", { name: "Сообщения", exact: true }),
    ).toBeVisible();
    await assertLayout();
  } finally {
    for (const f of fixtures) await f.close();
  }
});

test("resolving a cancellation prevents its delayed chime", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    await dashboard(f.adminPage);
    await f.adminPage.clock.pauseAt(Date.now());
    await f.send("Сообщение перед отменой");
    await expect
      .poll(async () => (await sound(f.adminPage)).plays.length)
      .toBe(1);
    const order = await f.cancelOrder();
    const banner = f.adminPage.getByRole("region", {
      name: "Отмены требуют решения",
      exact: true,
    });
    await expect(banner).toContainText(`Заказ #${order.orderNumber}`);
    await f.adminPost(`/admin/orders/${order.id}/final-cancel`);
    await expect(banner).toHaveCount(0);
    await f.adminPage.clock.fastForward(3100);
    expect((await sound(f.adminPage)).plays.map((p) => p.source)).toEqual([
      "/sounds/admin-chat-chime.wav",
    ]);
  } finally {
    await f.close();
  }
});

test("Activity refreshes unblocks and blocks from another dispatcher screen", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    await f.adminPage.goto("/adminReports");
    await expect(
      f.adminPage.getByRole("heading", { name: "Активность", exact: true }),
    ).toBeVisible();
    await f.adminPost(`/admin/drivers/${f.driverId}/block`, {
      reason: "Проверка активности",
    });
    await expect(
      f.adminPage
        .locator("main")
        .getByRole("listitem")
        .filter({ hasText: "Заблокирован водитель Водитель оповещений" }),
    ).toHaveCount(1);
    await f.adminPost(`/admin/drivers/${f.driverId}/unblock`);
    await expect(
      f.adminPage
        .locator("main")
        .getByRole("listitem")
        .filter({ hasText: "Разблокирован водитель Водитель оповещений" }),
    ).toHaveCount(1);
  } finally {
    await f.close();
  }
});

test("delayed old reoffer cannot silence the new cancellation attempt", async ({
  browser,
}) => {
  const f = await fixture(browser);
  let releaseReoffer: (() => void) | undefined;
  try {
    await f.adminPage.routeWebSocket("**/socket.io/**", (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (String(message).includes('"order:reoffered"'))
          releaseReoffer = () => socket.send(message);
        else socket.send(message);
      });
      socket.onMessage((message) => server.send(message));
    });
    await dashboard(f.adminPage);
    await f.adminPage.clock.pauseAt(Date.now());
    const order = await f.cancelOrder();
    const banner = f.adminPage.getByRole("region", {
      name: "Отмены требуют решения",
      exact: true,
    });
    await expect(banner).toContainText(`Заказ #${order.orderNumber}`);
    await expect
      .poll(async () => (await sound(f.adminPage)).plays.length)
      .toBe(1);
    await f.adminPost(`/admin/orders/${order.id}/reoffer`);
    await expect.poll(() => Boolean(releaseReoffer)).toBe(true);
    await f.adminPage.clock.fastForward(3100);
    await f.recancelOrder(order.id);
    await expect(banner).toContainText(`Заказ #${order.orderNumber}`);
    const recovered = f.adminPage.waitForResponse(
      (r) => r.url().includes("/admin/orders/cancellation-review") && r.ok(),
    );
    releaseReoffer!();
    await recovered;
    await f.adminPage.clock.fastForward(3100);
    expect(
      (await sound(f.adminPage)).plays.filter(
        (p) => p.source === "/sounds/admin-cancellation-chime.wav",
      ),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});
