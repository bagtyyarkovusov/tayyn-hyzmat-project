import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { installFixtureSession, loginFixture } from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");

test("profile reconciliation does not interrupt enabling notification sound", async ({
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
  await page.addInitScript(() =>
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      value: "granted",
    }),
  );
  let release!: () => void;
  let reached!: () => void;
  const mediaGate = new Promise<void>((resolve) => (release = resolve));
  const mediaRequested = new Promise<void>((resolve) => (reached = resolve));
  try {
    await page.goto("/driverProfile");
    const toggle = page.getByRole("switch", {
      name: "Уведомления",
      exact: true,
    });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.route("**/notification.mp3", async (route) => {
      reached();
      await mediaGate;
      await route.continue();
    });
    await toggle.click();
    await mediaRequested;
    await expect(toggle).toHaveAttribute("aria-busy", "true");
    const refreshed = page.waitForResponse(
      (response) => response.url().endsWith("/driver/profile") && response.ok(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    release();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).toHaveAttribute("aria-busy", "false");
  } finally {
    release();
    await context.close();
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});
