import { test, expect, type Browser, type Page } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");

async function actors(browser: Browser) {
  const prisma = new PrismaClient();
  try {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { phone: "+99360000000" },
      include: { admin: true },
    });
    const driver = await prisma.user.create({
      data: {
        phone: `+993${String(Date.now()).slice(-8)}`,
        fullName: `Водитель личных предложений ${Date.now()}`,
        role: "DRIVER",
        passwordHash: admin.passwordHash,
        driver: {
          create: {
            status: "APPROVED",
            districtId: process.env.TEST_REGION_ID,
          },
        },
        balance: { create: { amount: 500, currency: "TMT" } },
      },
      include: { driver: true },
    });
    const adminContext = await browser.newContext();
    const driverContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      permissions: ["geolocation"],
      geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
    });
    for (const [context, user, role, actorId] of [
      [adminContext, admin, "admin", admin.admin.id],
      [driverContext, driver, "driver", driver.driver.id],
    ] as const) {
      const token = jwt.sign(
        { sub: user.id, role: role.toUpperCase(), [`${role}Id`]: actorId },
        process.env.JWT_ACCESS_SECRET,
        { expiresIn: "5m" },
      );
      await context.addInitScript(
        ({ token, user, role }) => {
          localStorage.setItem(`openride.${role}.accessToken`, token);
          localStorage.setItem(`tayyn.${role}.user`, JSON.stringify(user));
        },
        {
          token,
          role,
          user: {
            id: user.id,
            fullName: user.fullName,
            role: role.toUpperCase(),
          },
        },
      );
    }
    const dispatcher = await adminContext.newPage(),
      page = await driverContext.newPage();
    await page.goto("/driverDashboard");
    const report = page.waitForResponse(
      (response) =>
        response.url().endsWith("/driver/location") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    expect((await report).ok()).toBe(true);
    await page
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
    return {
      dispatcher,
      driver: page,
      driverId: driver.driver.id as string,
      driverName: driver.fullName as string,
      driverContext,
      close: async () => {
        await adminContext.close();
        await driverContext.close();
      },
    };
  } finally {
    await prisma.$disconnect();
  }
}
async function fillOrder(page: Page, pickup: string) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Район", { exact: true })
    .selectOption(process.env.TEST_REGION_ID!);
  await dialog.getByLabel("Телефон клиента").fill("+99365000999");
  await dialog.getByLabel("Стоимость, TMT").fill("10");
  await dialog.getByLabel("Откуда", { exact: true }).fill(pickup);
}

test("dispatcher creates a private offer and driver explicitly accepts into the existing trip lifecycle", async ({
  browser,
}) => {
  const { dispatcher, driver, driverId, close } = await actors(browser);
  try {
    await dispatcher.goto("/adminOrders");
    await dispatcher
      .getByRole("button", { name: "Создать заказ", exact: true })
      .click();
    await fillOrder(dispatcher, "Личная подача");
    await dispatcher
      .getByRole("button", { name: "Лично водителю", exact: true })
      .click();
    await dispatcher
      .getByLabel("Водитель", { exact: true })
      .selectOption(driverId);
    await dispatcher
      .getByRole("button", { name: "Предложить на 20 секунд", exact: true })
      .click();
    const incoming = driver.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(
      incoming.getByRole("heading", { name: "Личное предложение" }),
    ).toBeVisible();
    await expect(incoming.getByRole("timer")).toHaveText(/(?:1[0-9]|20) сек/);
    await expect(
      incoming.getByText("Личная подача", { exact: true }),
    ).toBeVisible();
    await expect(
      driver.getByText("+99365000999", { exact: true }),
    ).not.toBeVisible();
    await incoming.getByLabel("Буду через").selectOption("5");
    await incoming
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await expect(incoming).not.toBeVisible();
    const trip = driver.getByRole("dialog", {
      name: "Управление поездкой",
      exact: true,
    });
    await expect(
      trip.getByRole("link", { name: "+99365000999", exact: true }),
    ).toBeVisible();
    await expect(
      trip.getByText("Прибытие: 5 мин", { exact: true }),
    ).toBeVisible();
    await expect(driver.getByLabel("Баланс")).toHaveText("490 TMT");
    await driver.screenshot({
      path: test.info().outputPath("private-offer-accepted-mobile.png"),
    });
    for (const name of ["Я на месте", "Начать поездку", "Завершить поездку"])
      await trip.getByRole("button", { name, exact: true }).click();
    await expect(trip).not.toBeVisible();
  } finally {
    await close();
  }
});

test("map-selected driver recovers a missed private offer on reconnect and declining releases it", async ({
  browser,
}) => {
  const { dispatcher, driver, driverId, driverName, driverContext, close } =
    await actors(browser);
  let createdOrderId: string | undefined;
  let adminHeaders: Record<string, string> | undefined;
  try {
    await dispatcher.goto("/adminOrders");
    const token = await dispatcher.evaluate(() =>
      localStorage.getItem("openride.admin.accessToken"),
    );
    const headers = { Authorization: `Bearer ${token}` };
    adminHeaders = headers;
    const created = await dispatcher.request.post("/api/admin/orders", {
      headers,
      data: {
        districtId: process.env.TEST_REGION_ID,
        clientPhone: "+99365000999",
        priceEstimated: 10,
        pickupAddress: "Подача с карты",
      },
    });
    expect(created.ok()).toBe(true);
    const order = await created.json();
    createdOrderId = order.id;
    // External map SDK may be unavailable: the same selected-driver panel is accessible from its driver list.
    await dispatcher.route("https://api-maps.yandex.ru/**", (route) =>
      route.abort(),
    );
    await dispatcher.goto("/adminMonitoring");
    await dispatcher
      .getByRole("button", { name: driverName, exact: true })
      .last()
      .click();
    await dispatcher
      .getByRole("region", { name: "Выбранный водитель", exact: true })
      .getByRole("button", { name: "Предложить заказ", exact: true })
      .click();
    await dispatcher
      .getByLabel("Заказ", { exact: true })
      .selectOption(order.id);
    await expect(
      dispatcher.getByLabel("Водитель", { exact: true }),
    ).toHaveValue(driverId);
    await driverContext.setOffline(true);
    await dispatcher
      .getByRole("button", { name: "Предложить на 20 секунд", exact: true })
      .click();
    await expect(dispatcher.getByRole("dialog")).not.toBeVisible();
    await driverContext.setOffline(false);
    const incoming = driver.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(
      incoming.getByRole("heading", { name: "Личное предложение" }),
    ).toBeVisible();
    await expect(
      incoming.getByText("Подача с карты", { exact: true }),
    ).toBeVisible();
    await driver.screenshot({
      path: test.info().outputPath("private-offer-recovered-mobile.png"),
    });
    await incoming
      .getByRole("button", { name: "Отказаться", exact: true })
      .click();
    await expect(
      incoming.getByRole("heading", { name: "Личное предложение" }),
    ).not.toBeVisible();
    const response = await dispatcher.request.get(`/api/admin/orders`, {
      headers,
      params: { status: "active", limit: 100 },
    });
    const listed = await response.json();
    expect(
      listed.items.find((item: { id: string }) => item.id === order.id),
    ).toMatchObject({
      status: "NEW",
      privateOfferDriverId: null,
      privateOfferExpiresAt: null,
    });
    await expect(driver.getByLabel("Баланс")).toHaveText("500 TMT");
  } finally {
    if (createdOrderId && adminHeaders) {
      const cleanup = await dispatcher.request.post(
        `/api/admin/orders/${createdOrderId}/cancel`,
        { headers: adminHeaders, data: {} },
      );
      expect(cleanup.ok()).toBe(true);
    }
    await close();
  }
});

async function createPrivateOrder(
  dispatcher: Page,
  driverId: string,
  pickupAddress: string,
) {
  const token = await dispatcher.evaluate(() =>
    localStorage.getItem("openride.admin.accessToken"),
  );
  const headers = { Authorization: `Bearer ${token}` };
  const response = await dispatcher.request.post("/api/admin/orders", {
    headers,
    data: {
      districtId: process.env.TEST_REGION_ID,
      clientPhone: "+99365000999",
      priceEstimated: 10,
      pickupAddress,
      privateOfferDriverId: driverId,
    },
  });
  expect(response.ok()).toBe(true);
  return { ...(await response.json()), headers };
}

test("a phone clock 30 seconds ahead still shows the server confirmation window", async ({
  browser,
}) => {
  const { dispatcher, driver, driverId, close } = await actors(browser);
  let created: Awaited<ReturnType<typeof createPrivateOrder>> | undefined;
  try {
    await dispatcher.goto("/adminOrders");
    await driver.clock.install();
    await driver.clock.setSystemTime(new Date(Date.now() + 30_000));
    created = await createPrivateOrder(
      dispatcher,
      driverId,
      "Подача с другим временем",
    );
    const incoming = driver.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(
      incoming.getByRole("heading", { name: "Личное предложение" }),
    ).toBeVisible();
    await expect(incoming.getByRole("timer")).toHaveText(/(?:1[0-9]|20) сек/);
    await incoming
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await expect(
      driver.getByRole("dialog", { name: "Управление поездкой", exact: true }),
    ).toBeVisible();
  } finally {
    if (created)
      await dispatcher.request.post(`/api/admin/orders/${created.id}/cancel`, {
        headers: created.headers,
        data: {},
      });
    await close();
  }
});

test("a delayed decline response leaves the newer private offer visible", async ({
  browser,
}) => {
  const { dispatcher, driver, driverId, close } = await actors(browser);
  const created: Awaited<ReturnType<typeof createPrivateOrder>>[] = [];
  let releaseDecline!: () => void, declineCommitted!: () => void;
  const declineGate = new Promise<void>((resolve) => {
    releaseDecline = resolve;
  });
  const committed = new Promise<void>((resolve) => {
    declineCommitted = resolve;
  });
  let releaseRecovery!: () => void, recoveryStarted!: () => void;
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const recovering = new Promise<void>((resolve) => {
    recoveryStarted = resolve;
  });
  try {
    await dispatcher.goto("/adminOrders");
    created.push(
      await createPrivateOrder(dispatcher, driverId, "Первое предложение"),
    );
    const incoming = driver.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(
      incoming.getByText("Первое предложение", { exact: true }),
    ).toBeVisible();
    await driver.route("**/orders/private-offer/decline", async (route) => {
      const response = await route.fetch();
      declineCommitted();
      await declineGate;
      await route.fulfill({ response });
    });
    await incoming
      .getByRole("button", { name: "Отказаться", exact: true })
      .click();
    await committed;
    created.push(
      await createPrivateOrder(dispatcher, driverId, "Новое предложение"),
    );
    await expect(
      incoming.getByText("Новое предложение", { exact: true }),
    ).toBeVisible();
    // Delay only transport recovery. The latest visible offer must survive the old response.
    await driver.route("**/orders/private-offer", async (route) => {
      recoveryStarted();
      await recoveryGate;
      await route.continue();
    });
    releaseDecline();
    await recovering;
    await expect(
      incoming.getByText("Новое предложение", { exact: true }),
    ).toBeVisible();
    await expect(
      incoming.getByRole("heading", { name: "Личное предложение" }),
    ).toBeVisible();
  } finally {
    releaseDecline();
    releaseRecovery();
    for (const order of created)
      await dispatcher.request.post(`/api/admin/orders/${order.id}/cancel`, {
        headers: order.headers,
        data: {},
      });
    await close();
  }
});
