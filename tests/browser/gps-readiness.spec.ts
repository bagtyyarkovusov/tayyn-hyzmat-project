import { test, expect } from "@playwright/test";
import { loginFixture, installFixtureSession } from "./helpers/device-session";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");

test("GPS waits for shift ownership profile before requesting coordinates", async ({
  browser,
}) => {
  const prisma = new PrismaClient();
  let userId: string | undefined;
  const context = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const delayed = new Promise<void>((resolve) => (reached = resolve));
  try {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { phone: "+99360000000" },
    });
    const fixture = await prisma.user.create({
      data: {
        phone: `+993${String(Date.now()).slice(-8)}`,
        fullName: "GPS readiness fixture",
        passwordHash: admin.passwordHash,
        role: "DRIVER",
        balance: { create: { amount: 500 } },
        driver: { create: { status: "APPROVED" } },
      },
    });
    userId = fixture.id;
    await installFixtureSession(
      context,
      "driver",
      await loginFixture(
        context.request,
        fixture.phone,
        `gps-readiness-${fixture.id}`,
      ),
      `gps-readiness-${fixture.id}`,
    );
    const page = await context.newPage();
    let profiles = 0;
    await page.route("**/api/driver/profile", async (route) => {
      // Let the route's initial session restoration finish, then hold the
      // dashboard's own profile load while its interactive controls render.
      if (++profiles > 1) {
        reached();
        await gate;
      }
      await route.continue();
    });
    await page.goto("/driverDashboard");
    await delayed;
    const gps = page.getByRole("button", { name: "Включить GPS", exact: true });
    await expect(gps).toBeDisabled();
    await expect(
      page.getByText(
        "Смена активна на другом устройстве. Завершите её там, чтобы выйти на линию здесь.",
        { exact: true },
      ),
    ).toHaveCount(0);
    release();
    await expect(gps).toBeEnabled();
    await gps.click();
    await expect(gps).toHaveAttribute("data-state", "ready");
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
