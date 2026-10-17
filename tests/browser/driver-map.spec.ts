import { test, expect, type Browser } from "@playwright/test";
import { createRequire } from "node:module";
import { installFixtureSession, loginFixture } from "./helpers/device-session";

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
      fullName: "Водитель карты",
      role: "DRIVER",
      passwordHash: admin.passwordHash,
      balance: { create: { amount: 500 } },
      driver: { create: { status: "APPROVED" } },
    },
    include: { driver: true },
  });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const deviceId = `map-${user.id}`;
  await installFixtureSession(
    context,
    "driver",
    await loginFixture(context.request, user.phone, deviceId),
    deviceId,
  );
  const page = await context.newPage();
  await page.addInitScript(() => {
    class Objects {
      constructor(private readonly node: HTMLElement) {}
      add(marker: { element: HTMLElement }) {
        this.node.append(marker.element);
      }
      remove(marker: { element: HTMLElement }) {
        marker.element.remove();
      }
    }
    class Marker {
      element = document.createElement("span");
      geometry = { setCoordinates: () => {} };
      options = { set: () => {} };
      properties = { set: () => {} };
      constructor() {
        this.element.dataset.mapMarker = "true";
      }
    }
    class MapStub {
      geoObjects: Objects;
      constructor(node: HTMLElement) {
        this.geoObjects = new Objects(node);
      }
      setCenter() {}
      destroy() {}
    }
    (window as any).ymaps = {
      ready: (callback: () => void) => callback(),
      Map: MapStub,
      Placemark: Marker,
    };
  });
  await page.goto("/driverMap");
  return {
    page,
    context,
    close: async () => {
      await context.close();
      await prisma.user.delete({ where: { id: user.id } });
      await prisma.$disconnect();
    },
  };
}

test("driver map is full-bleed and keeps only accessible map controls", async ({
  browser,
}) => {
  const { page, close } = await fixture(browser);
  try {
    await expect(
      page.getByRole("region", { name: "Карта водителя" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Показать моё положение на карте" }),
    ).toBeVisible();
    await expect(
      page.getByText("Центры районов и текущая поездка."),
    ).toHaveCount(0);
    await expect(page.getByText("Зелёный: ваш район")).toHaveCount(0);
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
  } finally {
    await close();
  }
});
