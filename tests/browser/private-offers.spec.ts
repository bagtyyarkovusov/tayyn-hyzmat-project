import { test, expect, type Browser, type Page } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
import { loginFixture, installFixtureSession } from "./helpers/device-session";
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
    const deviceId = `private-offer-${driver.id}`;
    await installFixtureSession(
      adminContext,
      "admin",
      await loginFixture(adminContext.request, admin.phone),
    );
    await installFixtureSession(
      driverContext,
      "driver",
      await loginFixture(driverContext.request, driver.phone, deviceId),
      deviceId,
    );
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
      trip.getByRole("link", { name: "+993 65 00 09 99", exact: true }),
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

for (const width of [320, 390]) {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const privateOffer of [false, true]) {
      test(`driver offer stays readable and dismissible at ${width}px ${colorScheme} ${privateOffer ? "private" : "public"}`, async ({
        browser,
      }) => {
        const { dispatcher, driver, driverId, close } = await actors(browser);
        try {
          await driver.setViewportSize({ width, height: 740 });
          await driver.emulateMedia({ colorScheme });
          await driver.evaluate(() => {
            document.documentElement.style.fontSize = "24px";
          });
          await dispatcher.goto("/adminOrders");
          const token = await dispatcher.evaluate(() =>
            localStorage.getItem("openride.admin.accessToken"),
          );
          const pickup =
            "Улица Махтумкули, дом 123, подъезд со стороны длинного проспекта " +
            "А".repeat(90);
          const created = await dispatcher.request.post(
            `${process.env.TEST_API_URL}/admin/orders`,
            {
              headers: { Authorization: `Bearer ${token}` },
              data: {
                districtId: process.env.TEST_REGION_ID,
                clientPhone: "+99365000999",
                priceEstimated: privateOffer ? 123.45 : 123456.78,
                pickupAddress: pickup,
                ...(privateOffer ? { privateOfferDriverId: driverId } : {}),
              },
            },
          );
          expect(created.ok()).toBe(true);
          const offer = driver.getByRole("dialog", {
            name: "Предложение заказа",
            exact: true,
          });
          await expect(
            offer.getByRole("heading", {
              name: privateOffer ? "Личное предложение" : "Новый заказ",
              exact: true,
            }),
          ).toBeVisible();
          await expect(offer.getByText(pickup, { exact: true })).toBeVisible();
          await expect(
            offer.getByText(privateOffer ? "123,45" : "123 456,78", {
              exact: true,
            }),
          ).toBeVisible();
          await expect(
            driver.getByText("+99365000999", { exact: true }),
          ).not.toBeVisible();
          if (privateOffer)
            await expect(offer.getByRole("timer")).toHaveText(
              /(?:1[0-9]|20) сек/,
            );
          const metrics = await offer.evaluate((dialog) => {
            const close =
              dialog.querySelector<HTMLButtonElement>(".dialog-close")!;
            const heading = [...dialog.querySelectorAll("h2")].find(
              (h) => !h.classList.contains("sr-only"),
            )!;
            const price = dialog.querySelector(".offer-price")!;
            const currency = price.lastElementChild!;
            const box = close.getBoundingClientRect(),
              title = heading.getBoundingClientRect();
            return {
              width: dialog.clientWidth,
              scrollWidth: dialog.scrollWidth,
              closeWidth: box.width,
              closeHeight: box.height,
              titleRight: title.right,
              closeLeft: box.left,
              priceSize: parseFloat(getComputedStyle(price).fontSize),
              currencySize: parseFloat(getComputedStyle(currency).fontSize),
              closeBorder: getComputedStyle(close).borderTopWidth,
              nestedBorder: getComputedStyle(dialog.querySelector("section")!)
                .borderTopWidth,
            };
          });
          expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.width);
          expect(metrics.closeWidth).toBeGreaterThanOrEqual(44);
          expect(metrics.closeHeight).toBeGreaterThanOrEqual(44);
          expect(metrics.titleRight).toBeLessThanOrEqual(metrics.closeLeft);
          if (privateOffer) {
            const titleBox = await offer
              .getByRole("heading", { name: "Личное предложение", exact: true })
              .boundingBox();
            const timerBox = await offer.getByRole("timer").boundingBox();
            expect(timerBox!.y).toBeGreaterThanOrEqual(
              titleBox!.y + titleBox!.height,
            );
          }
          expect(metrics.priceSize).toBeGreaterThan(metrics.currencySize);
          expect(metrics.closeBorder).toBe("0px");
          expect(metrics.nestedBorder).toBe("0px");
          await offer.getByLabel("Буду через").selectOption("15");
          await expect(offer.getByLabel("Буду через")).toHaveValue("15");
          const dismiss = offer.getByRole("button", {
            name: privateOffer ? "Отказаться" : "Скрыть предложение",
            exact: true,
          });
          await dismiss.scrollIntoViewIfNeeded();
          await expect(dismiss).toBeInViewport();
          const closeButton = offer.getByRole("button", {
            name: "Close",
            exact: true,
          });
          await closeButton.focus();
          await expect(closeButton).toBeFocused();
          await driver.screenshot({
            path: test.info().outputPath("offer-layout.png"),
          });
          await closeButton.press("Enter");
          if (privateOffer) {
            // Closing declines the private reservation. Its released public offer can reopen.
            await expect(
              offer.getByRole("heading", {
                name: "Личное предложение",
                exact: true,
              }),
            ).not.toBeVisible();
          } else await expect(offer).not.toBeVisible();
          await expect(driver.getByLabel("Баланс")).toHaveText("500 TMT");
          const order = await created.json();
          await dispatcher.request.post(
            `${process.env.TEST_API_URL}/admin/orders/${order.id}/cancel`,
            {
              headers: { Authorization: `Bearer ${token}` },
              data: { reason: "Synthetic layout test cleanup" },
            },
          );
        } finally {
          await close();
        }
      });
    }
  }
}
