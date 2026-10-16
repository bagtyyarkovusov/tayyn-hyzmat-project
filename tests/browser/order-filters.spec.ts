import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");

test("dispatcher order lifecycle lists are exclusive and default to unclaimed waiting orders", async ({
  browser,
}) => {
  const prisma = new PrismaClient();
  const orderIds: string[] = [];
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { phone: "+99360000000" },
      include: { admin: true },
    });
    const token = jwt.sign(
      { sub: admin.id, role: "ADMIN", adminId: admin.admin.id },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: "5m" },
    );
    const statuses = [
      "NEW",
      "ACCEPTED",
      "WAITING",
      "STARTED",
      "COMPLETED",
      "CANCELLED",
    ];
    for (const status of statuses) {
      const order = await prisma.order.create({
        data: {
          districtId: process.env.TEST_REGION_ID,
          status,
          pickupLat: 37.96,
          pickupLng: 58.32,
          clientPhone: "+99365000000",
          priceEstimated: 25,
          pickupAddress: `Проверка фильтра ${status}`,
        },
      });
      orderIds.push(order.id);
    }
    await context.addInitScript(
      ({ token, id }) => {
        localStorage.setItem("openride.admin.accessToken", token);
        localStorage.setItem(
          "tayyn.admin.user",
          JSON.stringify({ id, role: "ADMIN", fullName: "Диспетчер" }),
        );
      },
      { token, id: admin.id },
    );
    const page = await context.newPage();
    await page.goto("/adminOrders");
    const groups = [
      ["Ожидают", ["NEW"]],
      ["В работе", ["ACCEPTED", "WAITING", "STARTED"]],
      ["Завершённые", ["COMPLETED"]],
      ["Отменённые", ["CANCELLED"]],
      ["Все", statuses],
    ] as const;
    // The first assertion observes the default without clicking any filter.
    await expect(
      page.getByText("Проверка фильтра NEW", { exact: true }),
    ).toBeVisible();
    for (const [label, wanted] of groups) {
      await page.getByRole("button", { name: label, exact: true }).click();
      for (const status of statuses) {
        const row = page.getByText(`Проверка фильтра ${status}`, {
          exact: true,
        });
        if ((wanted as readonly string[]).includes(status))
          await expect(row).toBeVisible();
        else await expect(row).toHaveCount(0);
      }
    }
    await page.getByRole("button", { name: "Ожидают", exact: true }).click();
    await expect(
      page.getByText("Проверка фильтра NEW", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("waiting-orders-mobile.png"),
      fullPage: true,
    });
  } finally {
    await context.close();
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.$disconnect();
  }
});
