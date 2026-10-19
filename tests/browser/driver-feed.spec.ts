import {
  test,
  expect,
  type Browser,
  type Locator,
  type Page,
  type Request,
} from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
import { installNativeUiFixture } from "./helpers/native-ui";
import {
  loginFixture,
  installFixtureSession,
  isolateBrowserClient,
} from "./helpers/device-session";
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
    // GPS starts automatically; wait until the passive status shows a fix
    // so the server has a fresh location before the shift opens.
    await expect(page.getByRole("status", { name: /^GPS:/ })).toHaveAttribute(
      "data-state",
      "ready",
    );
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
    /** After a UI logout the fixture token is revoked and logout has already
     * released this device's shift. */
    async function close({ loggedOut = false } = {}) {
      await context.setOffline(false);
      for (const orderId of createdOrderIds) {
        const response = await context.request.post(
          `${process.env.TEST_API_URL}/admin/orders/${orderId}/cancel`,
          {
            headers: { Authorization: `Bearer ${adminToken}` },
            data: { outcome: "WITH_REFUND" },
          },
        );
        expect([200, 409]).toContain(response.status());
      }
      if (!loggedOut)
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
    async function adminGet(path: string) {
      return context.request.get(`${process.env.TEST_API_URL}${path}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    }
    async function serverBalance() {
      const response = await context.request.get(
        `${process.env.TEST_API_URL}/driver/balance`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(response.ok()).toBe(true);
      return Number((await response.json()).amount);
    }
    await installFixtureSession(context, "admin", adminSession, "");
    return {
      page,
      context,
      create,
      post,
      adminPost,
      adminGet,
      serverBalance,
      driverId: user.driver.id,
      phone: user.phone as string,
      close,
    };
  } finally {
    await prisma.$disconnect();
  }
}
async function pressNativeBack(page: Page) {
  const requestId = await page.evaluate(() =>
    (window as any).pressNativeBack(),
  );
  return nativeBackReply(page, requestId);
}
async function nativeBackReply(page: Page, requestId: number) {
  let result: string | undefined;
  await expect
    .poll(async () => {
      result = await page.evaluate(
        (id) =>
          (window as any).nativeBackReplies.find(
            (reply: { requestId: number }) => reply.requestId === id,
          )?.result,
        requestId,
      );
      return result;
    })
    .toBeTruthy();
  return result;
}
function gate() {
  let reached!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, reached, opened, release };
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
    const { page, create, post, serverBalance, close } = await fixture(
      browser,
      viewport,
    );
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
      await tripDialogTargetsFit(dialog, ["Я на месте"]);
      await expect(
        dialog.getByRole("button", { name: "Отменить заказ", exact: true }),
      ).toHaveCount(0);
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
      // Server first, then a freshly loaded screen rather than text left
      // over from acceptance.
      expect(await serverBalance()).toBe(475);
      await page.reload();
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
    await page.waitForTimeout(1000); // New offers ignore Back for one second.
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

test("dispatcher balance shows the acceptance deduction without a second debit", async ({
  browser,
}) => {
  const f = await fixture(browser);
  const adminPage = await f.context.newPage();
  try {
    const order = await f.create("Проверка удержанной суммы", {
      priceEstimated: 40,
    });
    async function wallet() {
      const response = await f.adminGet(
        `/admin/drivers/${f.driverId}/history?page=1&limit=100`,
      );
      expect(response.ok()).toBe(true);
      const body = await response.json();
      return {
        amount: Number(body.balance.amount),
        ledger: (
          body.transactions.items as {
            id: string;
            orderId: string | null;
            type: string;
            amount: string;
            balanceAfter: string;
          }[]
        ).map((entry) => ({
          id: entry.id,
          orderId: entry.orderId,
          type: entry.type,
          amount: Number(entry.amount),
          balanceAfter: Number(entry.balanceAfter),
        })),
      };
    }
    const totals = adminPage
      .locator("section")
      .filter({ has: adminPage.getByLabel("Сумма, TMT", { exact: true }) });
    /** A fresh dispatcher page load, so no earlier on-screen total can pass. */
    async function openWallet() {
      const issued = new Set<Request>();
      const track = (request: Request) => {
        if (
          new URL(request.url()).pathname.endsWith(
            `/admin/drivers/${f.driverId}/history`,
          )
        )
          issued.add(request);
      };
      adminPage.on("request", track);
      const loaded = adminPage.waitForResponse((response) =>
        issued.has(response.request()),
      );
      await adminPage.goto(`/adminDrivers/${f.driverId}`);
      await loaded.finally(() => adminPage.off("request", track));
      await adminPage
        .getByRole("button", { name: "Баланс", exact: true })
        .click();
      await expect(totals.getByText("460 TMT", { exact: true })).toBeVisible();
    }
    expect(
      (
        await f.post("/orders/accept", { orderId: order.id, etaMinutes: 10 })
      ).ok(),
    ).toBe(true);
    const afterAcceptance = await wallet();
    expect(afterAcceptance.amount).toBe(460);
    expect(await f.serverBalance()).toBe(460);
    expect(
      afterAcceptance.ledger.map(({ orderId, type, amount, balanceAfter }) => ({
        orderId,
        type,
        amount,
        balanceAfter,
      })),
    ).toEqual([
      { orderId: order.id, type: "PAYMENT", amount: -40, balanceAfter: 460 },
    ]);
    await openWallet();
    await expect(totals.getByText("Удержано", { exact: true })).toHaveCount(0);
    await expect(totals).toContainText(
      "Полная стоимость списывается при принятии заказа",
    );
    for (const action of ["waiting", "start", "complete"]) {
      expect(
        (await f.post(`/orders/${action}`, { orderId: order.id })).ok(),
      ).toBe(true);
      // Same wallet and the very same ledger rows: no second debit.
      expect(await wallet()).toEqual(afterAcceptance);
      expect(await f.serverBalance()).toBe(460);
      await openWallet();
    }
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
    await f.page.waitForTimeout(1000); // New offers ignore Back for one second.
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

async function openDriverTab(page: Page, name: string) {
  await page
    .getByRole("navigation", { name: "Разделы водителя" })
    .getByRole("link", { name, exact: true })
    .click();
}

test("an action error toast shows once across driver tab remounts and again after a retry", async ({
  browser,
}) => {
  const { page, create, post, close } = await fixture(browser);
  try {
    const order = await create("Проверка однократной ошибки");
    expect(
      (
        await post("/orders/accept", { orderId: order.id, etaMinutes: 10 })
      ).ok(),
    ).toBe(true);
    await page.reload();
    const trip = page.getByRole("dialog", {
      name: "Управление поездкой",
      exact: true,
    });
    await expect(trip).toBeVisible();
    await page.route("**/orders/waiting", (route) => route.abort("failed"));
    const toast = page.getByRole("listitem", { name: "Сообщение водителю" });
    async function failArrival() {
      await trip
        .getByRole("button", { name: "Я на месте", exact: true })
        .click();
      await expect(trip.getByRole("alert")).toBeVisible();
      await trip.getByRole("button", { name: "Close", exact: true }).click();
      await expect(toast).toBeVisible();
      await page
        .getByRole("button", { name: "Скрыть сообщение", exact: true })
        .click();
      await expect(toast).toHaveCount(0);
    }
    await failArrival();
    for (const name of ["Профиль", "Карта", "Чат"]) {
      await openDriverTab(page, name);
      await expect(page).not.toHaveURL(/driverDashboard$/);
      await openDriverTab(page, "Заказы");
      await expect(
        page.getByRole("heading", { name: "Заказы по районам" }),
      ).toBeAttached();
      await page.waitForTimeout(300); // Allow a remounted toast entrance to become observable.
      expect(await toast.count()).toBe(0);
    }
    // An explicit retry is a new occurrence and is reported again.
    await page.getByRole("button", { name: "Поездка", exact: true }).click();
    await failArrival();
  } finally {
    await close();
  }
});

test("Back and X are refused while a public offer acceptance is pending", async ({
  browser,
}) => {
  const f = await fixture(browser, { width: 390, height: 844 }, true);
  const accept = gate();
  try {
    await f.page.route("**/orders/accept", async (route) => {
      // Hold before the server commits, so no socket event ends the dialog.
      accept.reached();
      await accept.opened;
      await route.fallback();
    });
    await f.create("Назад во время принятия");
    const incoming = f.page.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(incoming).toBeVisible();
    await f.page.waitForTimeout(1100); // Past the new-offer Back guard.
    await incoming
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await accept.held;
    expect(await pressNativeBack(f.page)).toBe("handled");
    await expect(incoming).toBeVisible();
    await incoming.getByRole("button", { name: "Close", exact: true }).click();
    await expect(incoming).toBeVisible();
    accept.release();
    await expect(
      f.page.getByRole("dialog", { name: "Управление поездкой", exact: true }),
    ).toBeVisible();
    await expect(incoming).toHaveCount(0);
  } finally {
    accept.release();
    await f.close();
  }
});

test("an unsent chat draft survives driver tab switches and is cleared by logout", async ({
  browser,
}) => {
  const f = await fixture(browser);
  const { page } = f;
  let loggedOut = false;
  try {
    const composer = page.getByRole("textbox", {
      name: "Сообщение диспетчеру",
      exact: true,
    });
    await openDriverTab(page, "Чат");
    await composer.fill("Черновик для диспетчера");
    for (const name of ["Заказы", "Профиль", "Карта"]) {
      await openDriverTab(page, name);
      await expect(composer).toHaveCount(0);
      await openDriverTab(page, "Чат");
      await expect(composer).toHaveValue("Черновик для диспетчера");
    }
    await openDriverTab(page, "Профиль");
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/driverLogin/);
    loggedOut = true;
    await isolateBrowserClient(page.context());
    await page.getByLabel("Номер телефона").fill(f.phone.slice(4));
    await page
      .getByLabel("Пароль", { exact: true })
      .fill(process.env.TEST_ACCOUNT_PASSWORD!);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(/driverDashboard/);
    await openDriverTab(page, "Чат");
    await expect(composer).toHaveValue("");
  } finally {
    await f.close({ loggedOut });
  }
});

test("native Back within one second of a new offer is a root press and keeps the offer", async ({
  browser,
}) => {
  const f = await fixture(browser, { width: 390, height: 844 }, true);
  try {
    const pickup = "Второе нажатие Назад";
    // Press in the same task that observes the offer, as a second minimize
    // press landing just after the offer opens would.
    const firstPress = f.page.evaluate(
      (pickup) =>
        new Promise<number>((resolve) => {
          const observer = new MutationObserver(() => {
            const offer = [
              ...document.querySelectorAll('[role="dialog"]'),
            ].find((node) => node.textContent?.includes(pickup));
            if (!offer) return;
            observer.disconnect();
            resolve((window as any).pressNativeBack());
          });
          observer.observe(document.body, { childList: true, subtree: true });
        }),
      pickup,
    );
    await f.create(pickup);
    expect(await nativeBackReply(f.page, await firstPress)).toBe("root");
    const incoming = f.page.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(incoming).toBeVisible();
    await f.page.waitForTimeout(1000);
    expect(await pressNativeBack(f.page)).toBe("handled");
    await expect(incoming).toHaveCount(0);
  } finally {
    await f.close();
  }
});

test("forced offline is not overwritten by an older refresh still in flight", async ({
  browser,
}) => {
  const { page, context, close } = await fixture(browser);
  const profile = gate();
  const status = gate();
  try {
    let holdProfile = true;
    await page.route("**/driver/profile", async (route) => {
      if (!holdProfile) return route.fallback();
      holdProfile = false;
      const response = await route.fetch();
      profile.reached();
      await profile.opened;
      await route.fulfill({ response });
    });
    await page.route("**/driver/status", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      status.reached();
      await status.opened;
      await route.fallback();
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await profile.held;
    // Losing GPS permission forces the shift offline locally.
    await context.clearPermissions();
    // The passive GPS watcher receives the denial and forces the shift
    // offline without any enable-GPS control.
    await status.held;
    const goOnline = page.getByRole("button", {
      name: "Выйти на линию",
      exact: true,
    });
    await expect(goOnline).toBeVisible();
    const staleProfile = page.waitForResponse("**/driver/profile");
    profile.release();
    await staleProfile;
    await page.waitForTimeout(300);
    await expect(goOnline).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveCount(0);
  } finally {
    profile.release();
    status.release();
    await close();
  }
});

test("a late acceptance response cannot restore an order cancelled meanwhile", async ({
  browser,
}) => {
  const f = await fixture(browser);
  const accept = gate();
  const current = gate();
  try {
    await f.page.route("**/orders/accept", async (route) => {
      const response = await route.fetch();
      accept.reached();
      await accept.opened;
      await route.fulfill({ response });
    });
    const order = await f.create("Отменён до ответа принятия");
    const incoming = f.page.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await incoming
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await accept.held;
    expect(
      (
        await f.adminPost(`/admin/orders/${order.id}/cancel`, {
          outcome: "WITH_REFUND",
          reason: "Отмена до ответа водителю",
        })
      ).ok(),
    ).toBe(true);
    // The order:cancelled refresh has removed the offer.
    await expect(incoming).toHaveCount(0);
    // Keep later current-order reads pending so only the late response could
    // show a trip.
    await f.page.route("**/orders/current", async (route) => {
      await current.opened;
      await route.fallback();
    });
    const lateAccept = f.page.waitForResponse("**/orders/accept");
    accept.release();
    await lateAccept;
    await f.page.waitForTimeout(500);
    await expect(
      f.page.getByRole("dialog", { name: "Управление поездкой", exact: true }),
    ).toHaveCount(0);
    await expect(
      f.page.getByRole("region", { name: "Текущая поездка", exact: true }),
    ).toHaveCount(0);
  } finally {
    accept.release();
    current.release();
    await f.close();
  }
});
