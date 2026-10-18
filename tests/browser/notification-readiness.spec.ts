import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { installFixtureSession, loginFixture } from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");

test("profile focus reconciles without notification settings, sound, or permission prompts", async ({
  browser,
}) => {
  const prisma = new PrismaClient();
  const admin = await prisma.user.findUniqueOrThrow({
    where: { phone: "+99360000000" },
  });
  const user = await prisma.user.create({
    data: {
      phone: `+993${String(Date.now()).slice(-8)}`,
      fullName: "Notification readiness fixture",
      role: "DRIVER",
      passwordHash: admin.passwordHash,
      balance: { create: { amount: 500 } },
      driver: { create: { status: "APPROVED" } },
    },
  });
  const context = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const deviceId = `notification-${user.id}`;
  await installFixtureSession(
    context,
    "driver",
    await loginFixture(context.request, user.phone, deviceId),
    deviceId,
  );
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      value: "denied",
    });
    Object.defineProperty(window, "notificationRequests", { value: [] });
    Notification.requestPermission = async () => {
      (
        window as unknown as { notificationRequests: string[] }
      ).notificationRequests.push("permission");
      return "denied";
    };
    HTMLMediaElement.prototype.play = async () => {
      (
        window as unknown as { notificationRequests: string[] }
      ).notificationRequests.push("audio");
    };
  });
  try {
    await page.goto("/driverProfile");
    await expect(
      page.getByRole("button", { name: "Выйти", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("switch", { name: "Уведомления", exact: true }),
    ).toHaveCount(0);
    const refreshed = page.waitForResponse(
      (response) => response.url().endsWith("/driver/profile") && response.ok(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { notificationRequests: string[] })
            .notificationRequests,
      ),
    ).toEqual([]);
  } finally {
    await context.close();
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});
