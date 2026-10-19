import {
  test,
  expect,
  type Browser,
  type Request,
  type Response,
} from "@playwright/test";
import { createRequire } from "node:module";
import { loginFixture, installFixtureSession } from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
const api = process.env.TEST_API_URL;

async function fixture(browser: Browser) {
  const adminContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const driverContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const adminSession = await loginFixture(adminContext.request, "+99360000000");
  const adminHeaders = { Authorization: `Bearer ${adminSession.accessToken}` };
  const createdDriver = await adminContext.request.post(
    `${api}/admin/drivers`,
    {
      headers: adminHeaders,
      data: {
        phone: `+993${String(Date.now()).slice(-8)}`,
        fullName: "Водитель отмены 1.21",
        password: process.env.TEST_ACCOUNT_PASSWORD,
      },
    },
  );
  expect(createdDriver.ok()).toBe(true);
  const driver = await createdDriver.json();
  expect(
    (
      await adminContext.request.post(
        `${api}/admin/drivers/${driver.id}/balance`,
        {
          headers: adminHeaders,
          data: {
            operationId: crypto.randomUUID(),
            amount: 500,
            type: "TOPUP",
          },
        },
      )
    ).ok(),
  ).toBe(true);
  const driverSession = await loginFixture(
    driverContext.request,
    driver.user.phone,
    `cancellation-${driver.id}`,
  );
  const driverHeaders = {
    Authorization: `Bearer ${driverSession.accessToken}`,
  };
  await installFixtureSession(adminContext, "admin", adminSession);
  await installFixtureSession(
    driverContext,
    "driver",
    driverSession,
    `cancellation-${driver.id}`,
  );
  const adminPage = await adminContext.newPage();
  const driverPage = await driverContext.newPage();
  const cancelRequests: string[] = [];
  driverPage.on("request", (request) => {
    if (/\/orders\/cancel$/.test(request.url()))
      cancelRequests.push(request.url());
  });
  const orderIds: string[] = [];
  async function adminPost(path: string, data: object = {}) {
    return adminContext.request.post(`${api}${path}`, {
      headers: adminHeaders,
      data,
    });
  }
  async function driverPost(path: string, data: object = {}) {
    return driverContext.request.post(`${api}${path}`, {
      headers: driverHeaders,
      data,
    });
  }
  async function create() {
    const response = await adminPost("/admin/orders", {
      districtId: process.env.TEST_REGION_ID,
      clientPhone: "+99365999999",
      priceEstimated: 25,
      pickupAddress: "Проверка отмены 1.21",
    });
    expect(response.ok()).toBe(true);
    const order = await response.json();
    orderIds.push(order.id);
    return order;
  }
  async function online() {
    await driverPage.goto("/driverDashboard");
    await driverPage
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await driverPage
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      driverPage.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
  }
  async function historical(outcome: "NO_DEBIT" | "UNKNOWN") {
    const prisma = new PrismaClient();
    try {
      const order = await prisma.order.create({
        data: {
          status: "CANCELLED",
          driverId: driver.id,
          districtId: process.env.TEST_REGION_ID,
          pickupAddress: "Историческая отмена 1.21",
          cancellationOutcome: outcome,
          cancellationRefundAmount: 0,
          cancelledAt: new Date(),
        },
      });
      orderIds.push(order.id);
      return order;
    } finally {
      await prisma.$disconnect();
    }
  }
  async function serverBalance() {
    const response = await driverContext.request.get(`${api}/driver/balance`, {
      headers: driverHeaders,
    });
    expect(response.ok()).toBe(true);
    return Number((await response.json()).amount);
  }
  /** The driver's own ledger, newest first, exactly as the public history API returns it. */
  async function ledger() {
    const response = await driverContext.request.get(
      `${api}/driver/history?page=1&limit=200`,
      { headers: driverHeaders },
    );
    expect(response.ok()).toBe(true);
    const body = await response.json();
    return (
      body.transactions.items as {
        id: string;
        orderId: string | null;
        type: string;
        status: string;
        amount: string;
        balanceAfter: string;
      }[]
    ).map((entry) => ({
      id: entry.id,
      orderId: entry.orderId,
      type: entry.type,
      status: entry.status,
      amount: Number(entry.amount),
      balanceAfter: Number(entry.balanceAfter),
    }));
  }
  /** Ledger rows attributed to one order, oldest first. */
  async function orderLedger(orderId: string) {
    return (await ledger())
      .filter((entry) => entry.orderId === orderId)
      .reverse()
      .map(({ type, amount, balanceAfter }) => ({
        type,
        amount,
        balanceAfter,
      }));
  }
  /**
   * Resolves with the first driver-page balance read that is issued after
   * this call and returns `amount`. Register it before the action so a
   * screen value left over from an earlier read can never satisfy it.
   */
  function balanceRefresh(amount?: number) {
    const issued = new Set<Request>();
    const track = (request: Request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname.endsWith("/driver/balance")
      )
        issued.add(request);
    };
    driverPage.on("request", track);
    return driverPage
      .waitForResponse(
        async (response) =>
          issued.has(response.request()) &&
          (amount === undefined ||
            Number((await response.json()).amount) === amount),
      )
      .finally(() => driverPage.off("request", track));
  }
  /**
   * Server balance first; then the driver screen after a read issued since
   * the server check (the live refresh when given, and always a reload).
   */
  async function expectBalance(amount: number, live?: Promise<Response>) {
    expect(await serverBalance()).toBe(amount);
    const label = driverPage.getByLabel("Баланс", { exact: true });
    if (live) {
      await live;
      await expect(label).toHaveText(`${amount} TMT`);
    }
    const reloaded = balanceRefresh();
    if (new URL(driverPage.url()).pathname === "/driverDashboard")
      await driverPage.reload();
    else await driverPage.goto("/driverDashboard");
    expect(Number((await (await reloaded).json()).amount)).toBe(amount);
    await expect(label).toHaveText(`${amount} TMT`);
  }
  async function showOrder(order: { orderNumber: number }) {
    await adminPage.goto(
      `/adminOrders?status=all&orderNumber=${order.orderNumber}`,
    );
    const card = adminPage
      .getByRole("article")
      .filter({ hasText: `#${order.orderNumber}` });
    await expect(card).toBeVisible();
    return card;
  }
  async function close() {
    for (const id of orderIds)
      await adminPost(`/admin/orders/${id}/cancel`, { outcome: "WITH_REFUND" });
    await driverPost("/driver/status", { isOnline: false });
    await Promise.all([adminContext.close(), driverContext.close()]);
    const cleanup = new PrismaClient();
    try {
      await cleanup.order.deleteMany({ where: { id: { in: orderIds } } });
      await cleanup.user.delete({ where: { id: driver.userId } });
    } finally {
      await cleanup.$disconnect();
    }
  }
  return {
    adminPage,
    driverPage,
    driverContext,
    adminPost,
    driverPost,
    create,
    historical,
    online,
    serverBalance,
    ledger,
    orderLedger,
    balanceRefresh,
    expectBalance,
    showOrder,
    cancelRequests,
    close,
    driver,
  };
}

test("driver trip details have no cancellation action at any unfinished stage", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    await f.online();
    const order = await f.create();
    const incoming = f.driverPage.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    const steps = ["Я на месте", "Начать поездку", "Завершить поездку"];
    const trip = f.driverPage.getByRole("dialog", {
      name: "Управление поездкой",
      exact: true,
    });
    const accepted = f.balanceRefresh(475);
    await incoming
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await expect(
      trip.getByRole("button", { name: steps[0], exact: true }),
    ).toBeVisible();
    await f.expectBalance(475, accepted);
    expect(await f.orderLedger(order.id)).toEqual([
      { type: "PAYMENT", amount: -25, balanceAfter: 475 },
    ]);
    const afterAcceptance = await f.ledger();
    for (const [index, step] of steps.entries()) {
      await expect(
        trip.getByRole("button", { name: step, exact: true }),
      ).toBeVisible();
      await expect(
        trip.getByRole("button", { name: /Отменить|Подтвердить отмену/ }),
      ).toHaveCount(0);
      const refreshed = f.balanceRefresh(475);
      await trip.getByRole("button", { name: step, exact: true }).click();
      const next = steps[index + 1];
      if (next)
        await expect(
          trip.getByRole("button", { name: next, exact: true }),
        ).toBeVisible();
      else await expect(trip).toHaveCount(0);
      // Arrival, start and completion never charge again.
      await f.expectBalance(475, refreshed);
      expect(await f.ledger()).toEqual(afterAcceptance);
    }
    await expect(trip).toHaveCount(0);
    expect(f.cancelRequests).toEqual([]);
  } finally {
    await f.close();
  }
});

for (const stage of ["ACCEPTED", "WAITING", "STARTED"] as const) {
  for (const refund of [true, false]) {
    test(`dispatcher cancels ${stage} ${refund ? "with" : "without"} refund and refreshes history and balances`, async ({
      browser,
    }) => {
      const f = await fixture(browser);
      try {
        await f.online();
        const order = await f.create();
        const accepted = f.balanceRefresh(475);
        expect(
          (
            await f.driverPost("/orders/accept", {
              orderId: order.id,
              etaMinutes: 10,
            })
          ).ok(),
        ).toBe(true);
        await f.expectBalance(475, accepted);
        const payment = [{ type: "PAYMENT", amount: -25, balanceAfter: 475 }];
        expect(await f.orderLedger(order.id)).toEqual(payment);
        const afterAcceptance = await f.ledger();
        for (const action of stage === "STARTED"
          ? ["waiting", "start"]
          : stage === "WAITING"
            ? ["waiting"]
            : []) {
          const refreshed = f.balanceRefresh(475);
          expect(
            (
              await f.driverPost(`/orders/${action}`, { orderId: order.id })
            ).ok(),
          ).toBe(true);
          await f.expectBalance(475, refreshed);
          expect(await f.ledger()).toEqual(afterAcceptance);
        }
        const card = await f.showOrder(order);
        await expect(
          card.getByRole("button", {
            name: "Отменить с возвратом",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          card.getByRole("button", {
            name: "Отменить без возврата",
            exact: true,
          }),
        ).toBeVisible();
        const action = refund
          ? "Отменить с возвратом"
          : "Отменить без возврата";
        const label = refund ? "Отменён с возвратом" : "Отменён без возврата";
        await card.getByRole("button", { name: action, exact: true }).click();
        const dialog = f.adminPage.getByRole("dialog", {
          name: `${action}?`,
          exact: true,
        });
        await expect(dialog.getByRole("textbox")).toHaveCount(0);
        const settledAmount = refund ? 500 : 475;
        const cancelled = f.balanceRefresh(settledAmount);
        await dialog.getByRole("button", { name: action, exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(card.getByText(label, { exact: true })).toBeVisible();
        await expect(
          f.driverPage.getByRole("region", {
            name: "Текущая поездка",
            exact: true,
          }),
        ).toHaveCount(0);
        await f.expectBalance(settledAmount, cancelled);
        expect(await f.orderLedger(order.id)).toEqual(
          refund
            ? [...payment, { type: "REFUND", amount: 25, balanceAfter: 500 }]
            : payment,
        );
        // A repeated cancellation of either outcome is rejected without
        // touching the wallet or the ledger.
        const settled = await f.ledger();
        for (const outcome of ["WITH_REFUND", "WITHOUT_REFUND"])
          expect(
            (
              await f.adminPost(`/admin/orders/${order.id}/cancel`, {
                outcome,
              })
            ).status(),
          ).toBe(409);
        await f.expectBalance(settledAmount);
        expect(await f.ledger()).toEqual(settled);
        await f.adminPage.reload();
        await expect(card.getByText(label, { exact: true })).toBeVisible();
        await expect(
          f.adminPage.getByRole("region", {
            name: "Отмены требуют решения",
            exact: true,
          }),
        ).toHaveCount(0);
        await f.driverPage.goto("/driverProfile");
        const history = f.driverPage
          .locator("details")
          .filter({ hasText: `Проверка отмены 1.21` });
        await expect(history.locator("summary")).toContainText(label);
        await history.locator("summary").click();
        await expect(history.getByText(label, { exact: true })).toHaveCount(2);
        await expect(
          f.driverPage.getByText(
            "Полная стоимость списывается при принятии заказа.",
            { exact: false },
          ),
        ).toBeVisible();
        await expect(
          f.driverPage.getByRole("region", { name: "Данные водителя" }),
        ).toContainText(refund ? "500 TMT" : "475 TMT");
        expect(f.cancelRequests).toEqual([]);
      } finally {
        await f.close();
      }
    });
  }
}

test("unaccepted cancellation has one action and records before-acceptance outcome", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    const order = await f.create();
    const before = await f.ledger();
    const card = await f.showOrder(order);
    await expect(
      card.getByRole("button", { name: /Отменить .*возврат/ }),
    ).toHaveCount(0);
    await card
      .getByRole("button", { name: "Отменить заказ", exact: true })
      .click();
    const dialog = f.adminPage.getByRole("dialog", {
      name: "Отменить заказ?",
      exact: true,
    });
    await expect(dialog).toContainText("Списания и возврата нет.");
    await dialog
      .getByRole("button", { name: "Отменить заказ", exact: true })
      .click();
    await expect(
      card.getByText("Отменён до принятия", { exact: true }),
    ).toBeVisible();
    await f.expectBalance(500);
    expect(await f.orderLedger(order.id)).toEqual([]);
    expect(await f.ledger()).toEqual(before);
    await f.adminPage.reload();
    await expect(
      card.getByText("Отменён до принятия", { exact: true }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test("a stale dispatcher cancellation refreshes the recorded winner after 409", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    await f.online();
    const order = await f.create();
    expect(
      (
        await f.driverPost("/orders/accept", {
          orderId: order.id,
          etaMinutes: 10,
        })
      ).ok(),
    ).toBe(true);
    await f.expectBalance(475);
    const card = await f.showOrder(order);
    await card
      .getByRole("button", { name: "Отменить с возвратом", exact: true })
      .click();
    const dialog = f.adminPage.getByRole("dialog", {
      name: "Отменить с возвратом?",
      exact: true,
    });
    expect(
      (
        await f.adminPost(`/admin/orders/${order.id}/cancel`, {
          outcome: "WITHOUT_REFUND",
        })
      ).ok(),
    ).toBe(true);
    await f.expectBalance(475);
    expect(await f.orderLedger(order.id)).toEqual([
      { type: "PAYMENT", amount: -25, balanceAfter: 475 },
    ]);
    const settled = await f.ledger();
    const rejected = f.adminPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.endsWith(
          `/admin/orders/${order.id}/cancel`,
        ),
    );
    await dialog
      .getByRole("button", { name: "Отменить с возвратом", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);
    await expect(
      f.adminPage.getByRole("alert").filter({ hasText: "Заказ уже изменён" }),
    ).toBeVisible();
    await expect(
      card.getByText("Отменён без возврата", { exact: true }),
    ).toBeVisible();
    await expect(
      card.getByText("Отменён с возвратом", { exact: true }),
    ).toHaveCount(0);
    expect((await rejected).status()).toBe(409);
    await f.expectBalance(475);
    expect(await f.ledger()).toEqual(settled);
  } finally {
    await f.close();
  }
});

test("cancellation server errors keep the chosen action available for retry", async ({
  browser,
}) => {
  const f = await fixture(browser);
  try {
    await f.online();
    const order = await f.create();
    expect(
      (
        await f.driverPost("/orders/accept", {
          orderId: order.id,
          etaMinutes: 10,
        })
      ).ok(),
    ).toBe(true);
    await f.expectBalance(475);
    const afterAcceptance = await f.ledger();
    const card = await f.showOrder(order);
    const action = "Отменить без возврата";
    await card.getByRole("button", { name: action, exact: true }).click();
    const dialog = f.adminPage.getByRole("dialog", {
      name: `${action}?`,
      exact: true,
    });
    // Only the HTTP boundary fails once; the retry reaches the real backend.
    let failures = 0;
    await f.adminPage.route(
      `**/admin/orders/${order.id}/cancel`,
      async (route) => {
        failures += 1;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: "Сервис временно недоступен" }),
        });
      },
    );
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("alert")).not.toContainText(
      "Заказ уже изменён",
    );
    expect(failures).toBe(1);
    await f.expectBalance(475);
    expect(await f.ledger()).toEqual(afterAcceptance);
    await f.adminPage.unroute(`**/admin/orders/${order.id}/cancel`);
    await expect(
      dialog.getByRole("button", { name: action, exact: true }),
    ).toBeEnabled();
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(
      card.getByText("Отменён без возврата", { exact: true }),
    ).toBeVisible();
    await f.expectBalance(475);
    expect(await f.ledger()).toEqual(afterAcceptance);
  } finally {
    await f.close();
  }
});

for (const [outcome, label] of [
  ["NO_DEBIT", "Отменён без списания"],
  ["UNKNOWN", "Отменён · исход не определён"],
] as const) {
  test(`historical ${outcome} cancellation stays truthful in dispatcher and driver details`, async ({
    browser,
  }) => {
    const f = await fixture(browser);
    try {
      const order = await f.historical(outcome);
      const card = await f.showOrder(order);
      await expect(card.getByText(label, { exact: true })).toBeVisible();
      await expect(
        card.getByText("Отменён с возвратом", { exact: true }),
      ).toHaveCount(0);
      await expect(
        card.getByText("Отменён без возврата", { exact: true }),
      ).toHaveCount(0);
      await f.driverPage.goto("/driverProfile");
      const history = f.driverPage
        .locator("details")
        .filter({ hasText: "Историческая отмена 1.21" });
      await expect(history.locator("summary")).toContainText(label);
      await history.locator("summary").click();
      await expect(history.getByText(label, { exact: true })).toHaveCount(2);
      await f.expectBalance(500);
    } finally {
      await f.close();
    }
  });
}
