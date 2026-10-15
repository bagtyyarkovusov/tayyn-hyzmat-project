import { test, expect } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
const jwt = require("jsonwebtoken");
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");

test.use({ hasTouch: true });

test("monitoring shows driver information on map hover, tap and keyboard selection", async ({
  page,
  request,
}) => {
  // Authenticated fixtures avoid spending the shared auth rate-limit budget.
  // All behavior below still uses real HTTP/Socket.IO and the disposable DB.
  const prisma = new PrismaClient();
  const admin = await prisma.user.findUniqueOrThrow({
    where: { phone: "+10000000000" },
    include: { admin: true },
  });
  const driver = await prisma.user.findUniqueOrThrow({
    where: { phone: "+10000000102" },
    include: { driver: true },
  });
  await prisma.$disconnect();
  const accessToken = jwt.sign(
    { sub: driver.id, role: "DRIVER", driverId: driver.driver.id },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "5m" },
  );
  const adminToken = jwt.sign(
    { sub: admin.id, role: "ADMIN", adminId: admin.admin.id },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "5m" },
  );
  await page.addInitScript(
    ({ token, user }) => {
      localStorage.setItem("openride.admin.accessToken", token);
      localStorage.setItem("tayyn.admin.user", JSON.stringify(user));
    },
    {
      token: adminToken,
      user: { id: admin.id, fullName: admin.fullName, role: "ADMIN" },
    },
  );
  const location = await request.post(
    `${process.env.TEST_API_URL}/driver/location`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { lat: 37.9601, lng: 58.3261 },
    },
  );
  expect(location.ok()).toBe(true);
  // Only the external map SDK is replaced. Driver data comes from the real API.
  await page.route("https://api-maps.yandex.ru/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `window.ymaps = {
      ready: fn => fn(),
      Placemark: class {
        constructor(coords, properties) {
          this.properties = { set: () => {} };
          this.options = { set: () => {} };
          this.geometry = { setCoordinates: () => {} };
          this.element = document.createElement('button');
          this.element.textContent = 'Map marker';
          this.element.style.cssText = 'position:absolute;right:16px;bottom:16px';
          this.events = { add: (event, fn) => this.element.addEventListener(event === 'mouseenter' ? 'mouseenter' : event === 'mouseleave' ? 'mouseleave' : event, fn) };
        }
      },
      Map: class {
        constructor(element) { this.geoObjects = { add: marker => element.append(marker.element), remove: marker => marker.element.remove() }; }
        setCenter() {}
        destroy() {}
      }
    };`,
    }),
  );
  await page.clock.install();
  await page.goto("/adminMonitoring");
  const marker = page.getByRole("button", { name: "Map marker", exact: true });
  await expect(marker).toBeVisible();
  await marker.hover();
  const preview = page.getByRole("region", { name: "Водитель на карте" });
  await expect(preview).toContainText("Второй водитель");
  await expect(preview).toContainText("Не в сети");
  await expect(preview).toContainText("Координаты обновлены");
  await marker.click();
  await page.getByRole("heading", { name: "Мониторинг", exact: true }).hover();
  const details = page.getByRole("region", { name: "Выбранный водитель" });
  await expect(details).toContainText("Второй водитель");
  await expect(details).toContainText("Нет машины");
  await expect(details).toContainText("ТЕСТ — Центральный");
  await page
    .getByRole("button", { name: "Тестовый водитель", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(details).toContainText("Тестовый водитель");
  await expect(details).toContainText("Координат пока нет");
  await page.screenshot({
    path: test.info().outputPath("monitoring-desktop.png"),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await marker.tap();
  await expect(details).toContainText("Второй водитель");
  await page.clock.fastForward(75_000);
  await expect(details).toContainText("Координаты устарели");
  await page.screenshot({
    path: test.info().outputPath("monitoring-mobile.png"),
  });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
});
