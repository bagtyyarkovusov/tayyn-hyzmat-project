import {
  test,
  expect,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
import { installNativeUiFixture } from "./helpers/native-ui";
import { loginFixture, installFixtureSession } from "./helpers/device-session";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");

async function fixture(
  browser: Browser,
  viewport = { width: 390, height: 844 },
  native = false,
) {
  const prisma = new PrismaClient();
  try {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { phone: "+99360000000" },
      include: { admin: true },
    });
    const user = await prisma.user.create({
      data: {
        phone: `+993${String(Date.now()).slice(-8)}`,
        fullName: "Водитель экрана поездки",
        role: "DRIVER",
        passwordHash: admin.passwordHash,
        balance: { create: { amount: 500 } },
        driver: { create: { status: "APPROVED" } },
      },
      include: { driver: true },
    });
    const context = await browser.newContext({
      viewport,
      permissions: ["geolocation"],
      geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
    });
    if (native) await installNativeUiFixture(context, user.id);
    const deviceId = `feed-${user.id}`;
    const driverSession = await loginFixture(
      context.request,
      user.phone,
      deviceId,
    );
    const adminSession = await loginFixture(context.request, admin.phone);
    const token = driverSession.accessToken;
    const adminToken = adminSession.accessToken;
    await installFixtureSession(context, "driver", driverSession, deviceId);
    const page = await context.newPage();
    await page.goto("/driverDashboard");
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
    const createdOrderIds: string[] = [];
    async function create(
      pickupAddress: string,
      details: Record<string, unknown> = {},
    ) {
      const response = await context.request.post(
        `${process.env.TEST_API_URL}/admin/orders`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
          data: {
            districtId: process.env.TEST_REGION_ID,
            clientPhone: "+99365999999",
            priceEstimated: 25,
            pickupAddress,
            ...details,
          },
        },
      );
      expect(response.ok()).toBe(true);
      const order = await response.json();
      createdOrderIds.push(order.id);
      return order;
    }
    async function post(path: string, data: object) {
      return context.request.post(`${process.env.TEST_API_URL}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        data,
      });
    }
    async function close() {
      await context.setOffline(false);
      for (const orderId of createdOrderIds) {
        const response = await context.request.post(
          `${process.env.TEST_API_URL}/admin/orders/${orderId}/cancel`,
          {
            headers: { Authorization: `Bearer ${adminToken}` },
            data: { reason: "Disposable browser fixture cleanup" },
          },
        );
        expect([200, 409]).toContain(response.status());
      }
      expect((await post("/driver/status", { isOnline: false })).ok()).toBe(
        true,
      );
      await context.close();
      // This database is disposable, but later browser specs share it.
      // Remove only identities and orders created by this fixture.
      const cleanup = new PrismaClient();
      try {
        await cleanup.order.deleteMany({
          where: { id: { in: createdOrderIds } },
        });
        await cleanup.user.delete({ where: { id: user.id } });
      } finally {
        await cleanup.$disconnect();
      }
    }
    async function adminPost(path: string, data: object = {}) {
      return context.request.post(`${process.env.TEST_API_URL}${path}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        data,
      });
    }
    await installFixtureSession(context, "admin", adminSession, "");
    return {
      page,
      context,
      create,
      post,
      adminPost,
      driverId: user.driver.id,
      close,
    };
  } finally {
    await prisma.$disconnect();
  }
}
async function fits(page: Page) {
  const dimensions = await page.evaluate(() => ({
    h: document.documentElement.scrollHeight,
    w: document.documentElement.scrollWidth,
    vh: innerHeight,
    vw: innerWidth,
  }));
  expect(dimensions.h).toBeLessThanOrEqual(dimensions.vh);
  expect(dimensions.w).toBeLessThanOrEqual(dimensions.vw);
  const feed = page.getByRole("region", {
    name: "Текущая поездка",
    exact: true,
  });
  await expect(feed).toBeInViewport();
  for (const button of await feed.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expect(button).toBeInViewport();
  }
  for (const card of await page
    .getByRole("group", { name: "Регионы", exact: true })
    .getByRole("button")
    .all()) {
    const box = await card.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expect(card).toBeInViewport();
    const size = await card.evaluate((node) => ({
      scroll: node.scrollHeight,
      client: node.clientHeight,
      text: node.textContent,
    }));
    expect(size.scroll, JSON.stringify(size)).toBeLessThanOrEqual(size.client);
  }
}
async function tripDialogTargetsFit(dialog: Locator, names: string[]) {
  for (const name of names) {
    const control = dialog.getByRole("button", { name, exact: true });
    await expect(control).toBeVisible();
    const bounds = await control.boundingBox();
    expect(bounds, name).not.toBeNull();
    const dimensions = await control.evaluate((node) => ({
      minHeight: parseFloat(getComputedStyle(node).minHeight),
      width: node.clientWidth,
      contentWidth: node.scrollWidth,
      contentHeight: node.scrollHeight,
      height: node.clientHeight,
    }));
    expect(dimensions.minHeight, name).toBeGreaterThanOrEqual(48);
    expect(dimensions.contentWidth).toBeLessThanOrEqual(dimensions.width);
    expect(dimensions.contentHeight).toBeLessThanOrEqual(dimensions.height);
  }
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 568, height: 320 },
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 412, height: 732 },
]) {
  test(`active trip has a direct next step and client call without page scrolling at ${viewport.width}x${viewport.height}`, async ({
    browser,
  }) => {
    const { page, create, post, close } = await fixture(browser, viewport);
    try {
      const order = await create("Торговый центр, главный вход");
      expect(
        (
          await post("/orders/accept", { orderId: order.id, etaMinutes: 10 })
        ).ok(),
      ).toBe(true);
      await page.reload();
      const dialog = page.getByRole("dialog", {
        name: "Управление поездкой",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await tripDialogTargetsFit(dialog, ["Я на месте", "Отменить заказ"]);
      await dialog
        .getByRole("button", { name: "Отменить заказ", exact: true })
        .click();
      const confirmation = page.getByRole("dialog", {
        name: "Отменить текущий заказ?",
        exact: true,
      });
      await expect(confirmation).toBeVisible();
      await tripDialogTargetsFit(confirmation, [
        "Продолжить поездку",
        "Подтвердить отмену",
      ]);
      if (viewport.height >= 800) {
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "20px";
        });
        await tripDialogTargetsFit(confirmation, [
          "Продолжить поездку",
          "Подтвердить отмену",
        ]);
        await confirmation
          .getByRole("button", { name: "Продолжить поездку", exact: true })
          .click();
        await tripDialogTargetsFit(dialog, ["Я на месте"]);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "";
        });
      } else {
        await confirmation
          .getByRole("button", { name: "Продолжить поездку", exact: true })
          .click();
      }
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      const feed = page.getByRole("region", {
        name: "Текущая поездка",
        exact: true,
      });
      await expect(feed.getByLabel("Цена поездки")).toHaveText("25 TMT");
      await expect(
        feed.getByRole("link", { name: /Позвонить клиенту/ }),
      ).toHaveAttribute("href", "tel:+99365999999");
      await fits(page);
      await page.screenshot({
        path: test.info().outputPath("accepted-light.png"),
      });
      await feed
        .getByRole("button", { name: "Я на месте", exact: true })
        .click();
      if (viewport.height > 500)
        await expect(
          feed.getByRole("listitem").filter({ hasText: "Ожидание" }),
        ).toHaveAttribute("aria-current", "step");
      await feed.getByRole("button", { name: "Поездка", exact: true }).click();
      await tripDialogTargetsFit(dialog, ["Начать поездку"]);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await feed
        .getByRole("button", { name: "Начать поездку", exact: true })
        .click();
      if (viewport.height > 500)
        await expect(
          feed.getByRole("listitem").filter({ hasText: "В пути" }),
        ).toHaveAttribute("aria-current", "step");
      await feed.getByRole("button", { name: "Поездка", exact: true }).click();
      await tripDialogTargetsFit(dialog, ["Завершить поездку"]);
      await expect(
        dialog.getByRole("button", { name: "Отменить заказ", exact: true }),
      ).toHaveCount(0);
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.evaluate(() => document.documentElement.classList.add("dark"));
      await fits(page);
      await page.screenshot({
        path: test.info().outputPath("started-dark.png"),
      });
      if (viewport.height >= 800) {
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "20px";
        });
        await fits(page);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = "";
        });
      }
      await feed
        .getByRole("button", { name: "Завершить поездку", exact: true })
        .click();
      await expect(feed).toHaveCount(0);
      await expect(page.getByLabel("Баланс")).toHaveText("475 TMT");
    } finally {
      await close();
    }
  });
}

test("regional queue keeps ETA through live updates and reconnect, and removes a rival driver's claim", async ({
  browser,
}) => {
  const first = await fixture(browser, { width: 360, height: 640 });
  const rival = await fixture(browser, { width: 390, height: 844 });
  const { page, context, create } = first;
  try {
    await page
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: /ТЕСТ — Центральный/ })
      .click();
    const queue = page.getByRole("dialog", {
      name: "Заказы района",
      exact: true,
    });
    await expect(queue.getByText(/Сейчас нет свободных заказов/)).toBeVisible();
    const order = await create("Подача у первого входа");
    const item = queue
      .getByRole("article")
      .filter({ hasText: "Подача у первого входа" });
    await expect(item).toBeVisible();
    await item.getByLabel("Буду через").selectOption("20");
    for (let i = 0; i < 5; i++) await create(`Новая подача ${i + 1}`);
    await expect(queue.getByRole("article")).toHaveCount(6);
    await expect(item.getByLabel("Буду через")).toHaveValue("20");
    const last = queue.getByRole("article").last();
    await last
      .getByRole("button", { name: "Принять заказ", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      last.getByRole("button", { name: "Принять заказ", exact: true }),
    ).toBeInViewport();
    expect(
      await queue.evaluate((node) => node.scrollHeight <= node.clientHeight),
    ).toBe(true);
    const list = queue.getByRole("region", {
      name: "Доступные заказы",
      exact: true,
    });
    expect(
      await list.evaluate((node) => node.scrollHeight > node.clientHeight),
    ).toBe(true);
    await context.setOffline(true);
    await create("Подача после переподключения");
    await context.setOffline(false);
    await expect(queue.getByRole("article")).toHaveCount(7);
    await expect(item.getByLabel("Буду через")).toHaveValue("20");
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await expect(item.getByLabel("Буду через")).toHaveValue("20");
    expect(
      (
        await rival.post("/orders/accept", { orderId: order.id, etaMinutes: 5 })
      ).ok(),
    ).toBe(true);
    await expect(item).toHaveCount(0);
    await expect(queue.getByRole("article")).toHaveCount(6);
    // A stale second claimant is rejected by the same public API the UI uses.
    const stale = await first.post("/orders/accept", {
      orderId: order.id,
      etaMinutes: 20,
    });
    expect(stale.status()).toBe(409);
    await expect(page.getByLabel("Баланс")).toHaveText("500 TMT");
    await queue.screenshot({
      path: test.info().outputPath("queue-many-orders-mobile.png"),
    });
  } finally {
    await first.close();
    await rival.close();
  }
});

test("completed-trip feedback is consumed once across driver tab remounts", async ({
  browser,
}) => {
  const { page, create, post, close } = await fixture(browser);
  try {
    const order = await create("Проверка однократного сообщения");
    for (const action of ["accept", "waiting", "start"]) {
      expect(
        (
          await post(`/orders/${action}`, { orderId: order.id, etaMinutes: 10 })
        ).ok(),
      ).toBe(true);
    }
    await page.reload();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Текущая поездка", exact: true })
      .getByRole("button", { name: "Завершить поездку", exact: true })
      .click();
    const toast = page
      .getByRole("listitem", { name: "Сообщение водителю" })
      .filter({ hasText: "Поездка завершена." });
    await expect(toast).toBeVisible();
    await page
      .getByRole("button", { name: "Скрыть сообщение", exact: true })
      .click();
    for (const name of ["Профиль", "Карта", "Чат"]) {
      await page
        .getByRole("navigation", { name: "Разделы водителя" })
        .getByRole("link", { name, exact: true })
        .click();
      await expect(page).toHaveURL(
        new RegExp(
          name === "Профиль"
            ? "/driverProfile$"
            : name === "Карта"
              ? "/driverMap$"
              : "/driverChat$",
        ),
      );
      await expect(
        page.getByRole("heading", {
          name:
            name === "Профиль"
              ? "Профиль"
              : name === "Карта"
                ? "Карта водителя"
                : "Диспетчер",
          exact: true,
        }),
      ).toBeAttached();
      await page
        .getByRole("navigation", { name: "Разделы водителя" })
        .getByRole("link", { name: "Заказы", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Заказы по районам" }),
      ).toBeAttached();
      await page.waitForTimeout(300); // Allow the remounted toast entrance to become observable.
      expect(await toast.count()).toBe(0);
    }
    await create("Следующая поездка с тем же сообщением");
    const nextOffer = page.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await nextOffer
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    const nextTrip = page.getByRole("dialog", {
      name: "Управление поездкой",
      exact: true,
    });
    for (const name of ["Я на месте", "Начать поездку", "Завершить поездку"])
      await nextTrip.getByRole("button", { name, exact: true }).click();
    await expect(toast).toBeVisible();
  } finally {
    await close();
  }
});

test("incoming offers show a readable price, route, note and reduced-motion deadline", async ({
  browser,
}) => {
  const { page, create, close } = await fixture(browser, {
    width: 320,
    height: 640,
  });
  try {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const order = await create("Главный вход, торговый центр", {
      dropoffAddress: "Вокзал, северный вход",
      note: "Два пассажира",
    });
    const dialog = page.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(
      dialog.getByText(`Заказ #${order.orderNumber}`, { exact: true }),
    ).toBeVisible();
    await expect(dialog.locator(".offer-price")).toHaveText("25 TMT");
    expect(
      await dialog
        .locator(".offer-price")
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize)),
    ).toBeGreaterThanOrEqual(36);
    await expect(
      dialog.getByText("Главный вход, торговый центр", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Вокзал, северный вход", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Два пассажира", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText(/спишется|Телефон клиента откроется/),
    ).toHaveCount(0);
    await expect(dialog.getByRole("timer")).toContainText("сек");
    const first = await dialog.getByRole("timer").innerText();
    await expect(dialog.getByRole("timer")).not.toHaveText(first);
    expect(
      await dialog
        .locator(".offer-countdown > div")
        .evaluate((node) => getComputedStyle(node).transitionDuration),
    ).toBe("0s");
    const closeButton = dialog.getByRole("button", {
      name: "Close",
      exact: true,
    });
    const bounds = await closeButton.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({
      path: test.info().outputPath("incoming-small-light.png"),
    });
    await page.evaluate(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.style.fontSize = "20px";
    });
    await expect(closeButton).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("incoming-large-dark.png"),
    });
    await closeButton.click();
    await expect(dialog).toHaveCount(0);
    const recovery = page.waitForResponse(
      (response) =>
        response.url().endsWith("/driver/notifications/inbox") && response.ok(),
    );
    await page.reload();
    await recovery;
    await expect(page.getByLabel("Баланс", { exact: true })).toBeVisible();
    await page.waitForTimeout(150);
    expect(await dialog.count()).toBe(0);
  } finally {
    await close();
  }
});

test("driver cancellation is before arrival and dispatcher reoffers the same order with a fresh alert", async ({
  browser,
}) => {
  const f = await fixture(browser);
  const { page, context, create, close } = f;
  let releaseOld: (() => void) | undefined;
  try {
    let oldEventId = "";
    await page.routeWebSocket("**/socket.io/**", (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        const text = String(message);
        if (
          oldEventId &&
          text.includes('"order:taken"') &&
          text.includes(oldEventId)
        ) {
          releaseOld = () => socket.send(message);
        } else socket.send(message);
      });
      socket.onMessage((message) => server.send(message));
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
    const order = await create("Заказ для повторного предложения");
    oldEventId = order.notificationEventId;
    const incoming = page.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await incoming
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    const trip = page.getByRole("dialog", {
      name: "Управление поездкой",
      exact: true,
    });
    await trip
      .getByRole("button", { name: "Отменить заказ", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "Отменить текущий заказ?",
      exact: true,
    });
    await expect(confirmation.getByRole("textbox")).toHaveCount(0);
    await confirmation
      .getByRole("button", { name: "Подтвердить отмену", exact: true })
      .click();
    await expect(trip).toHaveCount(0);
    await expect.poll(() => Boolean(releaseOld)).toBe(true);
    const adminPage = await context.newPage();
    await adminPage.goto("/adminOrders?status=cancelled");
    const banner = adminPage.getByRole("region", {
      name: "Отмены требуют решения",
      exact: true,
    });
    await expect(
      banner.getByRole("link", {
        name: `Заказ #${order.orderNumber}`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      banner.getByRole("link", {
        name: "Водитель экрана поездки",
        exact: true,
      }),
    ).toHaveAttribute("href", `/adminDrivers/${f.driverId}`);
    const row = adminPage
      .getByRole("article")
      .filter({ hasText: `#${order.orderNumber}` });
    await row
      .getByRole("button", { name: "Предложить снова", exact: true })
      .click();
    await expect(row.getByText("Новый", { exact: true })).toBeVisible();
    await expect(banner).toHaveCount(0);
    await expect(incoming).toBeVisible();
    releaseOld!();
    await page.waitForTimeout(500);
    await expect(incoming).toBeVisible();
    await incoming
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await expect(trip).toBeVisible();
    await trip.getByRole("button", { name: "Я на месте", exact: true }).click();
    await expect(
      trip.getByRole("button", { name: "Отменить заказ", exact: true }),
    ).toHaveCount(0);
    expect(
      (await f.post("/orders/cancel", { orderId: order.id })).status(),
    ).toBe(409);
    await adminPage.close();
  } finally {
    await close();
  }
});

test("native Back closes the top overlay through its normal action then tabs return to Orders", async ({
  browser,
}) => {
  const { page, create, close } = await fixture(
    browser,
    { width: 390, height: 844 },
    true,
  );
  async function back(expected: "handled" | "root") {
    const requestId = await page.evaluate(() =>
      (window as any).pressNativeBack(),
    );
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (window as any).nativeBackReplies.find(
              (reply: { requestId: number }) => reply.requestId === id,
            )?.result,
          requestId,
        ),
      )
      .toBe(expected);
  }
  try {
    await create("Закрыть предложение кнопкой Назад");
    const incoming = page.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(incoming).toBeVisible();
    await back("handled");
    await expect(incoming).toHaveCount(0);
    await page
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: /ТЕСТ — Центральный/ })
      .click();
    const queue = page.getByRole("dialog", {
      name: "Заказы района",
      exact: true,
    });
    await expect(queue).toBeVisible();
    await back("handled");
    await expect(queue).toHaveCount(0);
    await page
      .getByRole("navigation", { name: "Разделы водителя" })
      .getByRole("link", { name: "Профиль", exact: true })
      .click();
    await expect(page).toHaveURL(/driverProfile$/);
    await expect(
      page.getByRole("button", { name: "Выйти", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("switch", { name: "Уведомления" })).toHaveCount(
      0,
    );
    await page.getByRole("button", { name: "Тема", exact: true }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await back("handled");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page).toHaveURL(/driverProfile$/);
    await back("handled");
    await expect(page).toHaveURL(/driverDashboard$/);
    await expect(
      page
        .getByRole("banner")
        .getByRole("button", { name: "Выйти", exact: true }),
    ).toHaveCount(0);
    await back("root");
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
    const nav = await page
      .getByRole("navigation", { name: "Разделы водителя" })
      .boundingBox();
    expect(nav!.y + nav!.height).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: test.info().outputPath("native-safe-insets.png"),
    });
    await page.setViewportSize({ width: 568, height: 320 });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--native-safe-left", "72px");
      document.documentElement.style.setProperty("--native-safe-right", "0px");
      document.documentElement.style.setProperty("--native-safe-top", "0px");
      document.documentElement.style.setProperty("--native-safe-bottom", "0px");
    });
    await page
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: /ТЕСТ — Центральный/ })
      .click();
    const landscapeDialog = await queue.boundingBox();
    expect(landscapeDialog!.x).toBeGreaterThanOrEqual(72);
    const closeBox = await queue
      .getByRole("button", { name: "Close", exact: true })
      .boundingBox();
    expect(closeBox!.x + closeBox!.width).toBeLessThanOrEqual(568);
    await back("handled");
  } finally {
    await close();
  }
});

test("all-drivers sent history merges labeled broadcasts into private conversations", async ({
  browser,
}) => {
  const f = await fixture(browser);
  const { context, page, close } = f;
  const adminPage = await context.newPage();
  try {
    await adminPage.goto("/adminChat?broadcast=1");
    await adminPage
      .getByRole("button", { name: "Сообщение всем", exact: true })
      .first()
      .click();
    const compose = adminPage.getByRole("dialog", {
      name: "Сообщение всем водителям",
      exact: true,
    });
    await compose
      .getByLabel("Текст сообщения", { exact: true })
      .fill("Всем: смена после дождя");
    await compose
      .getByRole("button", { name: "Отправить всем", exact: true })
      .click();
    const sent = adminPage.getByRole("region", {
      name: "Отправленные всем водителям",
      exact: true,
    });
    await expect(
      sent.getByText("Всем: смена после дождя", { exact: true }),
    ).toBeVisible();
    await adminPage.goto(`/adminChat/${f.driverId}`);
    const thread = adminPage.getByRole("region", {
      name: "Переписка",
      exact: true,
    });
    await expect(
      thread.getByText("Всем: смена после дождя", { exact: true }),
    ).toBeVisible();
    await expect(
      thread.getByText("Всем водителям", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Разделы водителя" })
      .getByRole("link", { name: "Чат", exact: true })
      .click();
    await expect(page).toHaveURL(/driverChat$/);
    await page
      .getByRole("textbox", { name: "Сообщение диспетчеру", exact: true })
      .fill("Личный ответ водителя");
    await page
      .getByRole("button", { name: "Отправить сообщение", exact: true })
      .click();
    await expect(
      thread.getByText("Личный ответ водителя", { exact: true }),
    ).toBeVisible();
    await adminPage.goto("/adminChat?broadcast=1");
    await expect(
      sent.getByText("Всем: смена после дождя", { exact: true }),
    ).toBeVisible();
    await expect(
      sent.getByText("Личный ответ водителя", { exact: true }),
    ).toHaveCount(0);
    await adminPage.screenshot({
      path: test.info().outputPath("dispatcher-broadcast-history.png"),
    });
  } finally {
    await adminPage.close();
    await close();
  }
});

test("dispatcher balance exposes held funds without debiting an acceptance", async ({
  browser,
}) => {
  const f = await fixture(browser);
  const adminPage = await f.context.newPage();
  try {
    const order = await f.create("Проверка удержанной суммы", {
      priceEstimated: 40,
    });
    expect(
      (
        await f.post("/orders/accept", { orderId: order.id, etaMinutes: 10 })
      ).ok(),
    ).toBe(true);
    await adminPage.goto(`/adminDrivers/${f.driverId}`);
    await adminPage
      .getByRole("button", { name: "Баланс", exact: true })
      .click();
    const totals = adminPage
      .locator("section")
      .filter({ has: adminPage.getByText("Удержано", { exact: true }) });
    await expect(totals.getByText("500 TMT", { exact: true })).toBeVisible();
    await expect(totals.getByText("40 TMT", { exact: true })).toBeVisible();
    await expect(totals.getByText("460 TMT", { exact: true })).toBeVisible();
    expect((await f.post("/orders/waiting", { orderId: order.id })).ok()).toBe(
      true,
    );
    await expect(totals.getByText("500 TMT", { exact: true })).toBeVisible();
    expect((await f.post("/orders/start", { orderId: order.id })).ok()).toBe(
      true,
    );
    await expect(totals.getByText("460 TMT", { exact: true })).toHaveCount(2);
    await expect(totals.getByText("0 TMT", { exact: true })).toBeVisible();
    expect((await f.post("/orders/complete", { orderId: order.id })).ok()).toBe(
      true,
    );
  } finally {
    await adminPage.close();
    await f.close();
  }
});

test("broadcast history preserves earlier pages and reading position during live sends", async ({
  browser,
}) => {
  const f = await fixture(browser);
  const admin = await f.context.newPage();
  try {
    const tag = `history-${crypto.randomUUID()}`;
    for (let i = 0; i < 33; i++)
      await f.adminPost("/admin/messages", {
        broadcast: true,
        body: `${tag}-${i}`,
        clientMessageId: crypto.randomUUID(),
      });
    await admin.goto("/adminChat?broadcast=1");
    const history = admin.getByRole("region", {
      name: "Отправленные всем водителям",
      exact: true,
    });
    await expect(history.getByText(`${tag}-32`, { exact: true })).toBeVisible();
    await history.evaluate((el) => {
      el.scrollTop = 0;
    });
    await admin.route("**/admin/messages/broadcasts?*", (route) =>
      new URL(route.request().url()).searchParams.has("beforeMessageId")
        ? route.abort("failed")
        : route.continue(),
    );
    await history
      .getByRole("button", {
        name: "Загрузить более ранние сообщения",
        exact: true,
      })
      .click();
    const historyError = history.getByRole("alert");
    await expect(historyError).toContainText("Не удалось загрузить историю");
    await admin.unroute("**/admin/messages/broadcasts?*");
    await historyError
      .getByRole("button", { name: "Повторить", exact: true })
      .click();
    await expect(history.getByText(`${tag}-0`, { exact: true })).toBeAttached();
    await history.evaluate((el) => {
      el.scrollTop = 100;
    });
    const before = await history.evaluate((el) => el.scrollTop);
    await f.adminPost("/admin/messages", {
      broadcast: true,
      body: `${tag}-live`,
      clientMessageId: crypto.randomUUID(),
    });
    await expect(
      history.getByText(`${tag}-live`, { exact: true }),
    ).toBeAttached();
    expect(await history.getByText(`${tag}-0`, { exact: true }).count()).toBe(
      1,
    );
    expect(
      Math.abs((await history.evaluate((el) => el.scrollTop)) - before),
    ).toBeLessThan(3);
  } finally {
    await admin.close();
    await f.close();
  }
});

test("pending controlled dialogs refuse Escape, X and native Back and keep failed actions visible", async ({
  browser,
}) => {
  const f = await fixture(browser, { width: 390, height: 844 }, true);
  const admin = await f.context.newPage();
  let release = () => {};
  try {
    const order = await f.create("Проверка отказа закрытия");
    await admin.goto("/adminOrders");
    await admin
      .getByRole("article")
      .filter({ hasText: `#${order.orderNumber}` })
      .getByRole("button", { name: "Отменить заказ", exact: true })
      .click();
    const dialog = admin.getByRole("dialog", {
      name: "Отменить заказ?",
      exact: true,
    });
    let reached!: () => void;
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await admin.route(`**/admin/orders/${order.id}/cancel`, async (route) => {
      reached();
      await gate;
      await route.abort("failed");
    });
    await dialog
      .getByRole("button", { name: "Отменить заказ", exact: true })
      .click();
    await held;
    await admin.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(dialog).toBeVisible();
    await admin.evaluate(() => (window as any).pressNativeBack());
    await expect
      .poll(() =>
        admin.evaluate(() => (window as any).nativeBackReplies.at(-1)?.result),
      )
      .toBe("handled");
    await expect(dialog).toBeVisible();
    release();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Отменить заказ", exact: true }),
    ).toBeEnabled();
  } finally {
    release();
    await admin.close();
    await f.close();
  }
});

test("failed private decline through native Back keeps the incoming offer and error visible", async ({
  browser,
}) => {
  const f = await fixture(browser, { width: 390, height: 844 }, true);
  try {
    await f.create("Неудавшийся отказ", { privateOfferDriverId: f.driverId });
    const dialog = f.page.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(
      dialog.getByText("Неудавшийся отказ", { exact: true }),
    ).toBeVisible();
    await f.page.route("**/orders/private-offer/decline", (route) =>
      route.abort("failed"),
    );
    await f.page.evaluate(() => (window as any).pressNativeBack());
    await expect
      .poll(() =>
        f.page.evaluate(() => (window as any).nativeBackReplies.at(-1)?.result),
      )
      .toBe("handled");
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(
      dialog.getByText("Неудавшийся отказ", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Отказаться", exact: true }),
    ).toBeEnabled();
  } finally {
    await f.close();
  }
});

test("a delayed acceptance response cannot dismiss a same-order reoffer", async ({
  browser,
}) => {
  const f = await fixture(browser);
  let release = () => {};
  try {
    let reached!: () => void;
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await f.page.route("**/orders/accept", async (route) => {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      reached();
      await gate;
      await route.fulfill({ response });
    });
    const first = await f.create("Задержанный ответ принятия");
    const incoming = f.page.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await incoming
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await held;
    expect((await f.post("/orders/cancel", { orderId: first.id })).ok()).toBe(
      true,
    );
    const reofferResponse = await f.adminPost(
      `/admin/orders/${first.id}/reoffer`,
    );
    expect(reofferResponse.ok()).toBe(true);
    const second = await reofferResponse.json();
    expect(second.notificationEventId).not.toBe(first.notificationEventId);
    await expect(incoming).toBeVisible();
    release();
    await expect(
      incoming.getByRole("button", { name: "Принять заказ", exact: true }),
    ).toBeEnabled();
    await f.page.waitForTimeout(300);
    expect(await incoming.count()).toBe(1);
    await expect(incoming.getByRole("timer")).toBeVisible();
  } finally {
    release();
    await f.close();
  }
});
