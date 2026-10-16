import {
  test,
  expect,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import { createRequire } from "node:module";
import { loginFixture, installFixtureSession } from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use the disposable browser runner");
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");

async function actors(browser: Browser, delayRegionalPopup = false) {
  const prisma = new PrismaClient();
  const stamp = Date.now();
  const regions: { id: string; name: string }[] = [];
  const users: { id: string; phone: string; driver: { id: string } }[] = [];
  const contexts: BrowserContext[] = [];
  const orders: string[] = [];
  let deliverRegionalPopup = () => {};
  let popupHeld!: () => void;
  const heldPopup = new Promise<void>((resolve) => {
    popupHeld = resolve;
  });
  const admin = await prisma.user.findUniqueOrThrow({
    where: { phone: "+99360000000" },
  });
  for (let index = 0; index < 2; index++) {
    const point = 10 + index * 10;
    regions.push(
      await prisma.district.create({
        data: {
          name: `Очередь ${index + 1} ${stamp}`,
          centerLat: point,
          centerLng: point,
          boundary: [
            [
              [point - 0.1, point - 0.1],
              [point - 0.1, point + 0.1],
              [point + 0.1, point + 0.1],
              [point + 0.1, point - 0.1],
              [point - 0.1, point - 0.1],
            ],
          ],
        },
      }),
    );
    users.push(
      await prisma.user.create({
        data: {
          phone: `+993${String(stamp + index).slice(-8)}`,
          fullName: `Водитель общей очереди ${index + 1}`,
          role: "DRIVER",
          passwordHash: admin.passwordHash,
          balance: { create: { amount: 500 } },
          driver: { create: { status: "APPROVED" } },
        },
        include: { driver: true },
      }),
    );
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      permissions: ["geolocation"],
      geolocation: { latitude: point, longitude: point, accuracy: 10 },
    });
    contexts.push(context);
    if (index === 1 && delayRegionalPopup) {
      await context.routeWebSocket("**/socket.io/**", (socket) => {
        const server = socket.connectToServer();
        server.onMessage((message) => {
          if (
            typeof message === "string" &&
            message.startsWith('42["order:new",')
          ) {
            deliverRegionalPopup = () => socket.send(message);
            popupHeld();
          } else socket.send(message);
        });
      });
    }
    const deviceId = `global-queue-${users[index]!.id}`;
    await installFixtureSession(
      context,
      "driver",
      await loginFixture(context.request, users[index]!.phone, deviceId),
      deviceId,
    );
  }
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const page of pages) {
    await page.goto("/driverDashboard");
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
  }
  const adminSession = await loginFixture(contexts[0]!.request, admin.phone);
  const headers = { Authorization: `Bearer ${adminSession.accessToken}` };
  async function create(pickupAddress: string, privateOffer = false) {
    const response = await contexts[0]!.request.post(
      `${process.env.TEST_API_URL}/admin/orders`,
      {
        headers,
        data: {
          districtId: regions[1]!.id,
          clientPhone: "+99365999999",
          priceEstimated: 25,
          pickupAddress,
          ...(privateOffer
            ? {
                privateOfferDriverId: users[1]!.driver.id,
                broadcastAfterPrivateExpiry: true,
              }
            : {}),
        },
      },
    );
    expect(response.ok()).toBe(true);
    const order = await response.json();
    orders.push(order.id);
    return order;
  }
  async function cancel(orderId: string) {
    const response = await contexts[0]!.request.post(
      `${process.env.TEST_API_URL}/admin/orders/${orderId}/cancel`,
      {
        headers,
        data: { reason: "Disposable browser cleanup" },
      },
    );
    expect(response.ok()).toBe(true);
  }
  return {
    viewer: pages[0]!,
    local: pages[1]!,
    contexts,
    region: regions[1]!,
    create,
    cancel,
    heldPopup,
    deliverRegionalPopup: () => deliverRegionalPopup(),
    close: async () => {
      for (const context of contexts) await context.close();
      await prisma.order.deleteMany({ where: { id: { in: orders } } });
      await prisma.user.deleteMany({
        where: { id: { in: users.map((user) => user.id) } },
      });
      await prisma.district.deleteMany({
        where: { id: { in: regions.map((region) => region.id) } },
      });
      await prisma.$disconnect();
    },
  };
}

test("a new public order is immediately claimable from another region and closes the local popup when claimed", async ({
  browser,
}) => {
  const { viewer, local, region, create, cancel, close } =
    await actors(browser);
  try {
    const card = viewer
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: new RegExp(region.name) });
    await expect(card.getByLabel("Заказов: 0. Машин на линии: 1")).toHaveText(
      "0:1",
    );
    await card.click();
    const queue = viewer.getByRole("dialog", {
      name: "Заказы района",
      exact: true,
    });
    await expect(queue.getByText(/Сейчас нет свободных заказов/)).toBeVisible();
    const order = await create("Доступен сразу в другом районе");
    await expect(
      queue.getByText("Доступен сразу в другом районе", { exact: true }),
    ).toBeVisible();
    await expect(
      viewer.getByRole("dialog", { name: "Предложение заказа", exact: true }),
    ).not.toBeVisible();
    const incoming = local.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(incoming.getByRole("timer")).toHaveText(/(?:1[0-9]|20) сек/);
    await queue
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await expect(queue).not.toBeVisible();
    await expect(incoming).not.toBeVisible();
    await viewer
      .getByRole("dialog", { name: "Управление поездкой", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    // Assigned unfinished orders remain in the region's active-order score.
    await expect(card.getByLabel("Заказов: 1. Машин на линии: 1")).toHaveText(
      "1:1",
    );
    await cancel(order.id);
    await expect(card.getByLabel("Заказов: 0. Машин на линии: 1")).toHaveText(
      "0:1",
    );
    expect(
      await viewer.evaluate(
        () => document.documentElement.scrollHeight <= innerHeight,
      ),
    ).toBe(true);
  } finally {
    await close();
  }
});

test("an order-new packet delayed behind a successful claim cannot reopen a taken offer", async ({
  browser,
}) => {
  const {
    viewer,
    local,
    region,
    create,
    heldPopup,
    deliverRegionalPopup,
    close,
  } = await actors(browser, true);
  try {
    const localCard = local
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: new RegExp(region.name) });
    await localCard.click();
    const localQueue = local.getByRole("dialog", {
      name: "Заказы района",
      exact: true,
    });
    await expect(
      localQueue.getByText(/Сейчас нет свободных заказов/),
    ).toBeVisible();
    await viewer
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: new RegExp(region.name) })
      .click();
    const remoteQueue = viewer.getByRole("dialog", {
      name: "Заказы района",
      exact: true,
    });
    await create("Позднее событие уже принятого заказа");
    await heldPopup;
    await expect(
      remoteQueue.getByText("Позднее событие уже принятого заказа", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      localQueue.getByText("Позднее событие уже принятого заказа", {
        exact: true,
      }),
    ).toBeVisible();
    await remoteQueue
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await expect(
      localQueue.getByText("Позднее событие уже принятого заказа", {
        exact: true,
      }),
    ).not.toBeVisible();
    await expect(
      localQueue.getByRole("region", { name: "Доступные заказы", exact: true }),
    ).toHaveAttribute("aria-busy", "false");
    const reconciled = local.waitForRequest(
      (request) =>
        request.url().includes("/orders/available") &&
        request.method() === "GET",
    );
    deliverRegionalPopup();
    const response = await (await reconciled).response();
    expect(response?.ok()).toBe(true);
    await response!.finished();
    await localQueue
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(
      local.getByRole("dialog", { name: "Предложение заказа", exact: true }),
    ).not.toBeVisible();
  } finally {
    await close();
  }
});

test("private expiry publishes into an already open remote queue without a second popup", async ({
  browser,
}) => {
  test.setTimeout(45000);
  const { viewer, local, region, create, cancel, close } =
    await actors(browser);
  try {
    await viewer
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: new RegExp(region.name) })
      .click();
    const queue = viewer.getByRole("dialog", {
      name: "Заказы района",
      exact: true,
    });
    const order = await create("Личное предложение стало общим", true);
    const incoming = local.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(
      incoming.getByRole("heading", {
        name: "Личное предложение",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      queue.getByText("Личное предложение стало общим", { exact: true }),
    ).not.toBeVisible();
    await expect(
      queue.getByText("Личное предложение стало общим", { exact: true }),
    ).toBeVisible({ timeout: 25000 });
    await expect(incoming).not.toBeVisible();
    await expect(
      viewer.getByRole("dialog", { name: "Предложение заказа", exact: true }),
    ).not.toBeVisible();
    await cancel(order.id);
    await expect(
      queue.getByText("Личное предложение стало общим", { exact: true }),
    ).not.toBeVisible();
  } finally {
    await close();
  }
});

test("the regional public popup expires after 20 seconds while the order stays available", async ({
  browser,
}) => {
  test.setTimeout(45000);
  const { local, region, create, cancel, close } = await actors(browser);
  try {
    const order = await create("Публичный заказ после таймера");
    const incoming = local.getByRole("dialog", {
      name: "Предложение заказа",
      exact: true,
    });
    await expect(incoming.getByRole("timer")).toHaveText(/(?:1[0-9]|20) сек/);
    await expect(incoming).not.toBeVisible({ timeout: 25000 });
    await local
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: new RegExp(region.name) })
      .click();
    const queue = local.getByRole("dialog", {
      name: "Заказы района",
      exact: true,
    });
    await expect(
      queue.getByText("Публичный заказ после таймера", { exact: true }),
    ).toBeVisible();
    await expect(
      queue.getByRole("button", { name: "Принять заказ", exact: true }),
    ).toBeEnabled();
    await cancel(order.id);
    await expect(
      queue.getByText("Публичный заказ после таймера", { exact: true }),
    ).not.toBeVisible();
  } finally {
    await close();
  }
});
