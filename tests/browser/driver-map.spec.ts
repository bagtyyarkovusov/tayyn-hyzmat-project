import { test, expect, type Browser } from "@playwright/test";
import { createRequire } from "node:module";
import { installFixtureSession, loginFixture } from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");

async function fixture(
  browser: Browser,
  trip?: {
    pickupLat: number;
    pickupLng: number;
    dropoffLat?: number;
    dropoffLng?: number;
    status?: "ACCEPTED" | "STARTED";
  },
) {
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
  const order = trip
    ? await prisma.order.create({
        data: {
          driverId: user.driver.id,
          districtId: process.env.TEST_REGION_ID,
          ...trip,
          status: trip.status || "ACCEPTED",
          priceEstimated: 25,
          acceptedAt: new Date(),
        },
      })
    : null;
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
      geometry = {
        setCoordinates: (point: number[]) => {
          this.element.dataset.point = point.join(",");
        },
      };
      options = {
        set: (name: string, value: string) => {
          this.element.dataset[name] = value;
        },
      };
      properties = {
        set: (values: { hintContent: string }) => {
          this.element.setAttribute("aria-label", values.hintContent);
        },
      };
      constructor(
        point: number[],
        properties: { hintContent: string },
        options: { preset: string },
      ) {
        this.element.dataset.mapMarker = "true";
        this.element.style.cssText = "display:block;width:10px;height:10px";
        this.element.setAttribute("role", "img");
        this.geometry.setCoordinates(point);
        this.properties.set(properties);
        this.options.set("preset", options.preset);
      }
    }
    class MapStub {
      geoObjects: Objects;
      events = {
        add: (
          name: string,
          callback: (event: { get: (key: string) => number[] }) => void,
        ) => {
          if (name === "boundschange") {
            let origin: { x: number; y: number } | undefined;
            this.node.addEventListener("pointerdown", (event) => {
              origin = { x: event.clientX, y: event.clientY };
            });
            this.node.addEventListener("pointerup", () => {
              origin = undefined;
            });
            this.node.addEventListener("pointermove", (event) => {
              if (
                origin &&
                Math.hypot(event.clientX - origin.x, event.clientY - origin.y) >
                  8
              ) {
                origin = undefined;
                callback({
                  get: (key) =>
                    key === "oldCenter" ? [37.961, 58.321] : [37.963, 58.323],
                });
              }
            });
          }
        },
      };
      constructor(
        private readonly node: HTMLElement,
        options: { controls: string[] },
      ) {
        this.geoObjects = new Objects(node);
        this.node.dataset.controls = options.controls.join(",");
        const attribution = document.createElement("a");
        attribution.textContent = "Яндекс · Открыть в Картах";
        attribution.href = "https://yandex.com/maps/";
        attribution.style.cssText =
          "position:absolute;bottom:0;right:0;height:24px";
        this.node.append(attribution);
      }
      setCenter(point: number[]) {
        this.node.dataset.center = point.join(",");
      }
      destroy() {}
    }
    (window as any).ymaps = {
      ready: (callback: () => void) => callback(),
      Map: MapStub,
      Placemark: Marker,
      route: () => {
        throw new Error("Driver map must never calculate a route");
      },
    };
  });
  await page.goto("/driverMap");
  return {
    page,
    context,
    close: async () => {
      await context.close();
      if (order) await prisma.order.delete({ where: { id: order.id } });
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
    const uploads: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().endsWith("/driver/location") &&
        request.method() === "POST"
      )
        uploads.push(request.url());
    });
    await expect(
      page.getByRole("region", { name: "Карта водителя" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Показать моё положение на карте" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Показать моё положение на карте" })
      .click();
    const own = page.getByRole("img", {
      name: "Текущее положение",
      exact: true,
    });
    await expect(own).toHaveAttribute("data-point", "37.96,58.32");
    await expect(own.locator("..")).toHaveAttribute(
      "data-center",
      "37.96,58.32",
    );
    await expect(page.getByRole("img")).toHaveCount(1);
    await expect(
      page.getByText("Центры районов и текущая поездка."),
    ).toHaveCount(0);
    await expect(page.getByText("Зелёный: ваш район")).toHaveCount(0);
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("full-map-mobile.png"),
    });
    expect(uploads).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 900 });
    const map = page.getByRole("region", { name: "Карта водителя" });
    const mapBox = await map.boundingBox();
    expect(mapBox!.x).toBe(0);
    expect(mapBox!.width).toBe(1280);
    expect(mapBox!.height).toBeGreaterThan(700);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("full-map-desktop.png"),
    });
  } finally {
    await close();
  }
});

test("valid trip points remain on the map and destination is emphasized after Start", async ({
  browser,
}) => {
  const { page, close } = await fixture(browser, {
    pickupLat: 37.97,
    pickupLng: 58.33,
    dropoffLat: 37.98,
    dropoffLng: 58.34,
    status: "STARTED",
  });
  try {
    const pickup = page.getByRole("img", {
      name: "Ориентир подачи: уточните по телефону",
      exact: true,
    });
    const destination = page.getByRole("img", {
      name: "Место назначения",
      exact: true,
    });
    await expect(pickup).toHaveAttribute("data-point", "37.97,58.33");
    await expect(pickup).toHaveAttribute(
      "data-preset",
      "islands:grayCircleDotIcon",
    );
    await expect(destination).toHaveAttribute("data-point", "37.98,58.34");
    await expect(destination).toHaveAttribute(
      "data-preset",
      "islands:redCircleDotIcon",
    );
    await expect(
      page.getByRole("button", { name: "Открыть текущую поездку" }),
    ).toBeVisible();
  } finally {
    await close();
  }
});

test("invalid pickup and a missing destination do not create map markers", async ({
  browser,
}) => {
  const { page, close } = await fixture(browser, {
    pickupLat: 91,
    pickupLng: 58.33,
  });
  try {
    await expect(
      page.getByRole("region", { name: "Карта водителя" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Открыть текущую поездку" }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", {
        name: "Ориентир подачи: уточните по телефону",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("img", { name: "Место назначения", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Показать моё положение на карте" })
      .click();
    await expect(
      page.getByRole("img", { name: "Текущее положение", exact: true }),
    ).toBeVisible();
  } finally {
    await close();
  }
});

test("GPS follows until a map pan, a tap keeps following and Locate resumes without off-shift uploads", async ({
  browser,
}) => {
  const { page, context, close } = await fixture(browser);
  try {
    const uploads: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().endsWith("/driver/location") &&
        request.method() === "POST"
      )
        uploads.push(request.url());
    });
    await page
      .getByRole("button", { name: "Показать моё положение на карте" })
      .click();
    const marker = page.getByRole("img", {
      name: "Текущее положение",
      exact: true,
    });
    const canvas = marker.locator("..");
    await expect(canvas).toHaveAttribute("data-controls", "");
    await expect(canvas).toHaveAttribute("data-center", "37.96,58.32");
    await canvas.click({ position: { x: 100, y: 100 } });
    await context.setGeolocation({
      latitude: 37.961,
      longitude: 58.321,
      accuracy: 10,
    });
    await expect(canvas).toHaveAttribute("data-center", "37.961,58.321");
    const box = await canvas.boundingBox();
    await page.mouse.move(box!.x + 100, box!.y + 100);
    await page.mouse.down();
    await page.mouse.move(box!.x + 170, box!.y + 140, { steps: 5 });
    await page.mouse.up();
    await context.setGeolocation({
      latitude: 37.962,
      longitude: 58.322,
      accuracy: 10,
    });
    await expect(marker).toHaveAttribute("data-point", "37.962,58.322");
    await expect(canvas).toHaveAttribute("data-center", "37.961,58.321");
    const locate = page.getByRole("button", {
      name: "Показать моё положение на карте",
    });
    await locate.click();
    await expect(canvas).toHaveAttribute("data-center", "37.962,58.322");
    const locateBox = await locate.boundingBox();
    const attribution = page.getByRole("link", { name: /Яндекс/ });
    await expect(attribution).toBeVisible();
    const attributionBox = await attribution.boundingBox();
    expect(locateBox!.y + locateBox!.height).toBeLessThan(attributionBox!.y);
    expect(uploads).toEqual([]);
  } finally {
    await close();
  }
});
