import { test, expect, type Browser, type Page } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
import { loginFixture, installFixtureSession } from "./helpers/device-session";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");

async function fixture(
  browser: Browser,
  viewport = { width: 390, height: 844 },
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
    async function create(pickupAddress: string) {
      const response = await context.request.post(
        `${process.env.TEST_API_URL}/admin/orders`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
          data: {
            districtId: process.env.TEST_REGION_ID,
            clientPhone: "+99365999999",
            priceEstimated: 25,
            pickupAddress,
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
    return { page, context, create, post, close };
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
      await feed
        .getByRole("button", { name: "Начать поездку", exact: true })
        .click();
      if (viewport.height > 500)
        await expect(
          feed.getByRole("listitem").filter({ hasText: "В пути" }),
        ).toHaveAttribute("aria-current", "step");
      await feed.getByRole("button", { name: "Поездка", exact: true }).click();
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
