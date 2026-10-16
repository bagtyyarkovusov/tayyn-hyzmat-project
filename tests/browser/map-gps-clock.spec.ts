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
const markerName = "Roster fixture ";
test.beforeAll(async () => {
  prisma = new PrismaClient();
  const passwordHash = await bcrypt.hash(process.env.TEST_ACCOUNT_PASSWORD!, 4);
  const region = await prisma.district.findFirstOrThrow();
  const user = await prisma.user.create({
    data: {
      phone: "+99361990001",
      fullName: markerName + "001",
      role: "DRIVER",
      passwordHash,
      balance: { create: { amount: 500 } },
      driver: {
        create: {
          status: "APPROVED",
          districtId: region.id,
          isOnline: true,
          isAvailable: true,
          lastLat: 37.96,
          lastLng: 58.32,
          lastLocationAt: new Date(),
        },
      },
    },
    include: { driver: true },
  });
  tracked = user.driver!.id;
});
test.afterAll(async () => {
  await prisma.driverLocation.deleteMany({ where: { driverId: tracked } });
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

test("new GPS fixes keep the selected map driver offerable between timer ticks", async ({
  page,
}) => {
  await mapStub(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await page
    .getByRole("button", { name: "Roster fixture 001", exact: true })
    .click();
  const loginResponse = await page.request.post(
    `${process.env.TEST_API_URL}/auth/login`,
    {
      data: {
        phone: "+99361990001",
        password: process.env.TEST_ACCOUNT_PASSWORD,
      },
      headers: { "X-Forwarded-For": "198.18.44.78" },
    },
  );
  expect(loginResponse.ok()).toBeTruthy();
  driverToken = (await loginResponse.json()).accessToken;
  for (const lat of [37.96, 37.96001, 37.96002]) {
    await page.waitForTimeout(1100);
    const response = await page.request.post(
      `${process.env.TEST_API_URL}/driver/location`,
      {
        data: { lat, lng: 58.32 },
        headers: {
          Authorization: `Bearer ${driverToken}`,
          "X-Forwarded-For": "198.18.44.78",
        },
      },
    );
    expect(response.ok()).toBeTruthy();
    await expect(page.getByText(`${lat},58.32`, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Предложить заказ", exact: true }),
    ).toBeEnabled({ timeout: 1000 });
  }
  await prisma.driver.update({
    where: { id: tracked },
    data: { lastLocationAt: new Date(Date.now() + 60_000), isOnline: true },
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Roster fixture 001", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Предложить заказ", exact: true }),
  ).toBeDisabled();
});
