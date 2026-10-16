import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
import { installFixtureSession, loginFixture } from "./helpers/device-session";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");

test("a profile refresh without an order does not interrupt enabling notification sound", async ({
  browser,
}) => {
  const prisma = new PrismaClient();
  const context = await browser.newContext();
  let userId: string | undefined;
  let release!: () => void;
  let reached!: () => void;
  const mediaGate = new Promise<void>((resolve) => (release = resolve));
  const mediaRequested = new Promise<void>((resolve) => (reached = resolve));
  try {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { phone: "+99360000000" },
    });
    const fixture = await prisma.user.create({
      data: {
        phone: `+993${String(Date.now()).slice(-8)}`,
        fullName: "Notification readiness fixture",
        role: "DRIVER",
        passwordHash: admin.passwordHash,
        balance: { create: { amount: 500 } },
        driver: { create: { status: "APPROVED" } },
      },
    });
    userId = fixture.id;
    const deviceId = `notification-${fixture.id}`;
    await installFixtureSession(
      context,
      "driver",
      await loginFixture(context.request, fixture.phone, deviceId),
      deviceId,
    );
    await context.addInitScript(() =>
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        value: "granted",
      }),
    );
    const page = await context.newPage();
    await page.goto("/driverDashboard");
    await expect(
      page.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toBeEnabled();
    await page.route("**/notification.mp3", async (route) => {
      reached();
      await mediaGate;
      await route.continue();
    });
    const alerts = page.getByRole("button", {
      name: "Включить уведомления и звук",
      exact: true,
    });
    await alerts.click();
    await mediaRequested;
    await expect(alerts).toHaveAttribute("data-state", "pending");
    const refreshed = Promise.all(
      [
        "/driver/profile",
        "/driver/balance",
        "/districts",
        "/orders/current",
      ].map((path) =>
        page
          .waitForResponse((r) => new URL(r.url()).pathname.endsWith(path))
          .then((r) => r.finished()),
      ),
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshed;
    // Let the browser render the reconciled profile before the held media load
    // finishes. The only stub is the timing of this external media resource.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    release();
    await expect(alerts).toHaveAttribute("data-state", "ready");
  } finally {
    release();
    await context.close();
    try {
      if (userId) await prisma.user.delete({ where: { id: userId } });
    } finally {
      await prisma.$disconnect();
    }
  }
});
