import { test, expect } from "@playwright/test";
import { isolateBrowserClient } from "./helpers/device-session";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
let fixtureUserId = "";
let fixtureOrderId = "";
test.afterEach(async () => {
  const prisma = new PrismaClient();
  try {
    if (fixtureOrderId)
      await prisma.order.deleteMany({ where: { id: fixtureOrderId } });
    if (fixtureUserId)
      await prisma.user.deleteMany({ where: { id: fixtureUserId } });
  } finally {
    await prisma.$disconnect();
    fixtureUserId = "";
    fixtureOrderId = "";
  }
});
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");
test("dispatcher can manually complete a started drive or choose either cancellation outcome", async ({
  page,
}) => {
  await isolateBrowserClient(page.context());
  await page.goto("/adminLogin");
  await page.getByLabel("Номер телефона").fill("60000000");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.TEST_ACCOUNT_PASSWORD!);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/adminDashboard/);
  const adminToken = await page.evaluate(() =>
    localStorage.getItem("openride.admin.accessToken"),
  );
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };
  const driverResponse = await page.request.post(
    `${process.env.TEST_API_URL}/admin/drivers`,
    {
      headers: adminHeaders,
      data: {
        phone: "+99361999791",
        fullName: "Started recovery fixture",
        password: process.env.TEST_ACCOUNT_PASSWORD,
      },
    },
  );
  expect(driverResponse.status()).toBe(201);
  const fixture = await driverResponse.json();
  fixtureUserId = fixture.userId;
  expect(
    (
      await page.request.post(
        `${process.env.TEST_API_URL}/admin/drivers/${fixture.id}/balance`,
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
  const auth = await page.request.post(
    `${process.env.TEST_API_URL}/auth/login`,
    {
      data: {
        phone: "+99361999791",
        password: process.env.TEST_ACCOUNT_PASSWORD,
        deviceId: "synthetic-approved-browser",
      },
    },
  );
  expect(auth.ok()).toBe(true);
  const driverToken = (await auth.json()).accessToken;
  const driverHeaders = { Authorization: `Bearer ${driverToken}` };
  expect(
    (
      await page.request.post(`${process.env.TEST_API_URL}/driver/status`, {
        headers: driverHeaders,
        data: {
          isOnline: true,
          isAvailable: true,
          position: {
            lat: 37.96,
            lng: 58.32,
            capturedAt: Date.now(),
            accuracy: 10,
          },
        },
      })
    ).ok(),
  ).toBe(true);
  const created = await page.request.post(
    `${process.env.TEST_API_URL}/admin/orders`,
    {
      headers: adminHeaders,
      data: {
        districtId: process.env.TEST_REGION_ID,
        clientPhone: "+99365999999",
        priceEstimated: 30,
        pickupAddress: "Проверка начатой поездки",
      },
    },
  );
  expect(created.status()).toBe(201);
  const order = await created.json();
  fixtureOrderId = order.id;
  for (const action of ["accept", "waiting", "start"]) {
    const result = await page.request.post(
      `${process.env.TEST_API_URL}/orders/${action}`,
      { headers: driverHeaders, data: { orderId: order.id } },
    );
    expect(result.status(), await result.text()).toBe(200);
  }
  await page.goto("/adminOrders");
  await page.getByRole("button", { name: "В работе", exact: true }).click();
  const card = page
    .getByRole("article")
    .filter({ hasText: "Проверка начатой поездки" });
  await expect(
    card.getByRole("button", { name: "Отменить заказ", exact: true }),
  ).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Отменить с возвратом", exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Отменить без возврата", exact: true }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "Завершить вручную", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Завершить поездку вручную?",
    exact: true,
  });
  await expect(dialog.getByText(/возврата нет/)).toBeVisible();
  const confirm = dialog.getByRole("button", {
    name: "Завершить поездку",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByLabel("Причина")
    .fill("Клиент подтвердил прибытие по телефону");
  await confirm.click();
  await expect(dialog).toBeHidden();
  const history = await page.request.get(
    `${process.env.TEST_API_URL}/driver/history`,
    { headers: driverHeaders },
  );
  const result = await history.json();
  expect(
    result.orders.items.find((item: any) => item.id === order.id).status,
  ).toBe("COMPLETED");
  expect(
    result.transactions.items
      .filter((item: any) => item.orderId === order.id)
      .map((item: any) => item.type),
  ).toEqual(["PAYMENT"]);
  expect(
    (
      await page.request.post(`${process.env.TEST_API_URL}/driver/status`, {
        headers: driverHeaders,
        data: { isOnline: false },
      })
    ).ok(),
  ).toBe(true);
});
