import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");
let prisma: InstanceType<typeof PrismaClient>;
let tracked = "";
let driverToken = "";
const markerName = "Monitoring roster fixture ";
test.beforeAll(async () => {
  prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(process.env.TEST_ACCOUNT_PASSWORD!, 4);
  const region = await prisma.district.findFirstOrThrow();
  for (let i = 1; i <= 105; i++) {
    const user = await prisma.user.create({
      data: {
        phone: `+9936188${String(i).padStart(4, "0")}`,
        fullName: markerName + String(i).padStart(3, "0"),
        role: "DRIVER",
        passwordHash,
        balance: { create: { amount: 500 } },
        driver: {
          create: {
            status: "APPROVED",
            districtId: i === 105 ? null : region.id,
            isOnline: i <= 50,
            isAvailable: i !== 2,
            lastLat: 37.96,
            lastLng: 58.32,
            lastLocationAt: new Date(),
          },
        },
      },
      include: { driver: true },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        driverId: user.driver!.id,
        make: "Toyota",
        model: "Corolla",
        plateNumber: `MONROSTER${String(i).padStart(3, "0")}`,
        status: "ACTIVE",
      },
    });
    await prisma.driver.update({
      where: { id: user.driver!.id },
      data: { currentVehicleId: vehicle.id },
    });
    if (i === 1) tracked = user.driver!.id;
  }
});
test.afterAll(async () => {
  await prisma.driverLocation.deleteMany({ where: { driverId: tracked } });
  await prisma.driver.updateMany({
    where: { user: { fullName: { startsWith: markerName } } },
    data: { currentVehicleId: null },
  });
  await prisma.user.deleteMany({
    where: { fullName: { startsWith: markerName } },
  });
  await prisma.$disconnect();
});
async function mapStub(page: Page) {
  await page.addInitScript(() => {
    class Objects {
      constructor(private node: HTMLElement) {}
      add(marker: { element: HTMLElement }) {
        this.node.append(marker.element);
      }
      remove(marker: { element: HTMLElement }) {
        marker.element.remove();
      }
    }
    class MapStub {
      geoObjects: Objects;
      setCenter() {}
      destroy() {}
      constructor(node: HTMLElement) {
        this.geoObjects = new Objects(node);
      }
    }
    class Marker {
      element = document.createElement("span");
      geometry = {
        setCoordinates: (coords: number[]) => {
          this.element.textContent = coords.join(",");
        },
      };
      options = { set() {} };
      events = { add() {} };
      constructor(coords: number[]) {
        this.element.style.display = "inline-block";
        this.geometry.setCoordinates(coords);
      }
    }
    (window as any).ymaps = {
      ready: (callback: () => void) => callback(),
      Map: MapStub,
      Placemark: Marker,
    };
  });
}
async function login(page: Page) {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "198.18.44.77" });
  await page.goto("/adminLogin");
  await page.getByLabel("Номер телефона").fill("60000000");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.TEST_ACCOUNT_PASSWORD!);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/adminDashboard/);
  await page.goto("/adminMonitoring");
}

test("monitoring loads beyond a hundred drivers and keeps a compact searchable roster across screen sizes", async ({
  page,
}) => {
  await mapStub(page);
  await login(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const roster = page.getByRole("region", {
    name: "Список водителей",
    exact: true,
  });
  await expect(roster.getByRole("status")).toContainText("из 108");
  await expect(roster.getByRole("button")).toHaveCount(108);
  const regionFilter = roster.getByLabel("Район", { exact: true });
  await expect
    .poll(() => regionFilter.locator("option").count())
    .toBeGreaterThan(3);
  const configuredRegion = await regionFilter
    .getByRole("option", { name: "ТЕСТ · Мир", exact: true })
    .getAttribute("value");
  expect(configuredRegion).toBeTruthy();
  await regionFilter.selectOption(configuredRegion!);
  await expect(
    roster.getByText("Водители не найдены", { exact: true }),
  ).toBeVisible();
  await roster.getByRole("button", { name: "Сбросить фильтры" }).click();
  const row = roster.getByRole("button", {
    name: /Monitoring roster fixture 001/,
  });
  expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await row.boundingBox())!.height).toBeLessThanOrEqual(64);
  await roster.getByLabel("Поиск водителя").fill("MONROSTER105");
  await expect(
    roster.getByRole("button", { name: /Monitoring roster fixture 105/ }),
  ).toBeVisible();
  await expect(roster.getByRole("status")).toContainText("Показано 1 из 108");
  await roster.getByLabel("Поиск водителя").fill("+993 61 88 0105");
  await expect(
    roster.getByRole("button", { name: /Monitoring roster fixture 105/ }),
  ).toBeVisible();
  await roster.getByLabel("Район", { exact: true }).selectOption("outside");
  await expect(roster.getByRole("status")).toContainText("Показано 1 из 108");
  await roster.getByLabel("Статус водителя").selectOption("available");
  await expect(
    roster.getByText("Водители не найдены", { exact: true }),
  ).toBeVisible();
  await roster.getByRole("button", { name: "Сбросить фильтры" }).click();
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    if (width < 1024)
      await page
        .getByRole("button", { name: "Водители · 108", exact: true })
        .click();
    const active = width < 1024 ? page.getByRole("dialog") : roster;
    for (const dark of [false, true]) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle("dark", value),
        dark,
      );
      await expect(active.getByLabel("Поиск водителя")).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
    }
    if (width < 1024) {
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Водители · 108", exact: true }),
      ).toBeFocused();
    }
  }
});

test("fresh GPS updates preserve selected driver, focused search and availability without fetching the whole fleet", async ({
  page,
}) => {
  await mapStub(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  const roster = page.getByRole("region", {
    name: "Список водителей",
    exact: true,
  });
  await expect(roster.getByRole("status")).toContainText("из 108");
  const loginResponse = await page.request.post(
    `${process.env.TEST_API_URL}/auth/login`,
    {
      data: {
        phone: "+99361880001",
        password: process.env.TEST_ACCOUNT_PASSWORD,
        deviceId: "synthetic-approved-browser",
      },
      headers: { "X-Forwarded-For": "198.18.44.78" },
    },
  );
  expect(loginResponse.ok()).toBeTruthy();
  driverToken = (await loginResponse.json()).accessToken;
  await roster
    .getByLabel("Поиск водителя")
    .fill("Monitoring roster fixture 001");
  await roster
    .getByRole("button", { name: /Monitoring roster fixture 001/ })
    .click();
  await roster.getByLabel("Поиск водителя").focus();
  const before = [] as string[];
  page.on("request", (request) => {
    if (request.url().includes("/admin/drivers?")) before.push(request.url());
  });
  // Flush the bounded connect reconciliation before measuring location-only traffic.
  await page.waitForTimeout(5500);
  before.length = 0;
  for (let i = 0; i < 3; i++) {
    const focused =
      i === 1
        ? roster.getByRole("button", { name: /Monitoring roster fixture 001/ })
        : roster.getByLabel("Поиск водителя");
    await focused.focus();
    const response = await page.request.post(
      `${process.env.TEST_API_URL}/driver/location`,
      {
        data: { lat: [37.96, 37.96001, 37.96002][i], lng: 58.32 },
        headers: {
          Authorization: `Bearer ${driverToken}`,
          "X-Forwarded-For": "198.18.44.78",
        },
      },
    );
    expect(response.ok()).toBeTruthy();
    if (i > 0)
      await expect(
        page
          .getByLabel("Карта водителей")
          .getByText(["37.96,58.32", "37.96001,58.32", "37.96002,58.32"][i], {
            exact: true,
          }),
      ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Предложить заказ", exact: true }),
    ).toBeEnabled();
    await expect(
      roster.getByRole("button", { name: /Monitoring roster fixture 001/ }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(focused).toBeFocused();
  }
  expect(before).toHaveLength(0);
});

test("all saved regions stay selectable when every driver is offline outside regions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/admin/drivers?**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.items = body.items.map((driver: Record<string, unknown>) => ({
      ...driver,
      isOnline: false,
      district: null,
    }));
    await route.fulfill({ response, json: body });
  });
  await login(page);
  const roster = page.getByRole("region", {
    name: "Список водителей",
    exact: true,
  });
  const regions = roster.getByLabel("Район", { exact: true });
  await expect(
    regions.getByRole("option", { name: "ТЕСТ · Мир", exact: true }),
  ).toHaveCount(1);
  await expect(
    regions.getByRole("option", { name: "Вне районов", exact: true }),
  ).toHaveCount(1);
  const emptyRegion = await regions
    .getByRole("option", { name: "ТЕСТ · Мир", exact: true })
    .getAttribute("value");
  await regions.selectOption(emptyRegion!);
  await expect(
    roster.getByText("Водители не найдены", { exact: true }),
  ).toBeVisible();
  await regions.selectOption("outside");
  await expect(roster.getByRole("status")).toContainText("Показано 108 из 108");
});
