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
      fullName: "Водитель оповещений",
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
  return {
    adminPage: await adminContext.newPage(),
    secondAdminPage: await secondAdminContext.newPage(),
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
