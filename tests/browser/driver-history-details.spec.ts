import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");

test("driver can expand their trip history to inspect route, customer contact and lifecycle details on mobile", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/adminLogin");
  await page.getByLabel("Номер телефона").fill("60000000");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.TEST_ACCOUNT_PASSWORD!);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/adminDashboard/);
  const token = await page.evaluate(() =>
    localStorage.getItem("openride.admin.accessToken"),
  );
  const response = await page.request.post(
    `${process.env.TEST_API_URL}/admin/drivers`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        phone: "+99361999812",
        fullName: "История подробностей",
        password: process.env.TEST_ACCOUNT_PASSWORD,
      },
    },
  );
  expect(response.status()).toBe(201);
  const driver = await response.json();
  const prisma = new PrismaClient();
  const orderIds: string[] = [];
  try {
    // Historical records are isolated setup fixtures. Every behavior assertion
    // below uses the driver's actual screen backed by the real history API.
    const completed = await prisma.order.create({
      data: {
        driverId: driver.id,
        districtId: process.env.TEST_REGION_ID,
        status: "COMPLETED",
        pickupLat: 37.96,
        pickupLng: 58.32,
        pickupAddress: "улица Гёроглы, 12",
        dropoffAddress: "проспект Гарашсызлык, 110",
        clientPhone: "+99365995424",
        priceEstimated: 30,
        priceFinal: 35,
        note: "Вход со двора, позвонить перед приездом",
        createdAt: new Date("2026-10-15T10:00:00Z"),
        acceptedAt: new Date("2026-10-15T10:01:00Z"),
        startedAt: new Date("2026-10-15T10:05:00Z"),
        completedAt: new Date("2026-10-15T10:20:00Z"),
      },
    });
    orderIds.push(completed.id);
    const cancelled = await prisma.order.create({
      data: {
        driverId: driver.id,
        districtId: process.env.TEST_REGION_ID,
        status: "CANCELLED",
        pickupLat: 37.96,
        pickupLng: 58.32,
        pickupAddress: null,
        dropoffAddress: null,
        clientPhone: null,
        priceEstimated: 20,
        cancelReason: "Клиент отказался от поездки",
        createdAt: new Date("2026-10-14T10:00:00Z"),
        acceptedAt: new Date("2026-10-14T10:01:00Z"),
        cancelledAt: new Date("2026-10-14T10:02:00Z"),
      },
    });
    orderIds.push(cancelled.id);
    await page.addInitScript(() =>
      localStorage.setItem(
        "openride.driver.deviceId",
        "history-details-browser",
      ),
    );
    await page.goto("/driverLogin");
    await page.getByLabel("Номер телефона").fill("61999812");
    await page
      .getByLabel("Пароль", { exact: true })
      .fill(process.env.TEST_ACCOUNT_PASSWORD!);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(/driverDashboard/);
    await page.getByRole("link", { name: "Профиль", exact: true }).click();
    const trip = page
      .locator("details")
      .filter({ has: page.getByText("улица Гёроглы, 12", { exact: true }) });
    await expect(trip.getByText("35 TMT", { exact: true })).toBeVisible();
    await expect(
      trip.locator("summary").getByText("Завершён", { exact: true }),
    ).toBeVisible();
    await expect(
      trip.getByText("ТЕСТ — Центральный", { exact: true }),
    ).toBeVisible();
    await expect(
      trip.getByRole("link", { name: "+993 65 99 54 24", exact: true }),
    ).toBeHidden();
    await trip.locator("summary").click();
    await expect(trip.getByText("Откуда", { exact: true })).toBeVisible();
    await expect(trip.getByText("Куда", { exact: true })).toBeVisible();
    await expect(
      trip.getByText("проспект Гарашсызлык, 110", { exact: true }),
    ).toBeVisible();
    await expect(
      trip.getByRole("link", { name: "+993 65 99 54 24", exact: true }),
    ).toHaveAttribute("href", "tel:+99365995424");
    await expect(
      trip.getByText("Вход со двора, позвонить перед приездом", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(trip.getByText(completed.id, { exact: true })).toBeVisible();
    for (const label of ["Создан", "Принят", "Начало поездки", "Завершён"])
      await expect(trip.getByText(label, { exact: true }).last()).toBeVisible();
    const missing = page.locator("details").filter({
      has: page.getByText("Место подачи не указано", { exact: true }),
    });
    await missing.locator("summary").click();
    await expect(
      missing.getByText("Точный адрес не указан", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      missing.getByText("Место назначения не указано", { exact: true }),
    ).toBeVisible();
    await expect(
      missing.getByText("Номер не указан", { exact: true }),
    ).toBeVisible();
    await expect(
      missing.getByText("Клиент отказался от поездки", { exact: true }),
    ).toBeVisible();
    await expect(missing.getByRole("link", { name: /\+993/ })).toHaveCount(0);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
    await trip.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "test-results/driver-history-details-mobile.png",
    });
  } finally {
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.user.delete({ where: { id: driver.userId } });
    await prisma.$disconnect();
  }
});
