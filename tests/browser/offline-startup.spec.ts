import { test, expect, type Page } from "@playwright/test";
import { isolateBrowserClient } from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");

async function signIn(page: Page) {
  await isolateBrowserClient(page.context());
  await page.goto("/driverLogin");
  await page.getByLabel("Номер телефона").fill("60000101");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.TEST_ACCOUNT_PASSWORD!);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Разделы водителя" }),
  ).toBeVisible();
}

async function expectLocked(page: Page) {
  await expect(page.locator(".workspace")).toHaveCount(0);
  await expect(page.getByRole("navigation")).toHaveCount(0);
}

test("cold start renders checking immediately and bounds a never responding verification", async ({
  page,
}) => {
  await signIn(page);
  const refresh = await page.evaluate(() =>
    localStorage.getItem("openride.driver.refreshToken"),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/driver/profile", async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Проверяем подключение…", { exact: true }),
  ).toBeVisible({ timeout: 2000 });
  await expectLocked(page);
  await expect(
    page.getByRole("button", { name: "Повторить подключение", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  expect(
    await page.evaluate(() =>
      localStorage.getItem("openride.driver.refreshToken"),
    ),
  ).toBe(refresh);
  release();
  await page.unroute("**/api/driver/profile");
  await page
    .getByRole("button", { name: "Повторить подключение", exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: "Разделы водителя" }),
  ).toBeVisible();
});

test("known offline startup skips verification and reconnects automatically", async ({
  page,
}) => {
  await signIn(page);
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    }),
  );
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/driver/")) requests++;
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Нет интернета. Данные входа сохранены.", { exact: true }),
  ).toBeVisible({ timeout: 2000 });
  await expectLocked(page);
  expect(requests).toBe(0);
  await page
    .getByRole("button", { name: "Повторить подключение", exact: true })
    .click();
  await expect(
    page.getByText("Нет интернета. Данные входа сохранены.", { exact: true }),
  ).toBeVisible();
  expect(requests).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => true,
    });
    window.dispatchEvent(new Event("online"));
  });
  await expect(
    page.getByRole("navigation", { name: "Разделы водителя" }),
  ).toBeVisible();
});

for (const path of ["/driverDashboard", "/adminDashboard"]) {
  test(`signed out offline ${path} opens login and refuses a false login`, async ({
    page,
  }) => {
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => false,
      }),
    );
    await page.goto(path);
    await expect(page.getByLabel("Номер телефона")).toBeVisible();
    await expectLocked(page);
    await page.getByLabel("Номер телефона").fill("60000101");
    await page
      .getByLabel("Пароль", { exact: true })
      .fill(process.env.TEST_ACCOUNT_PASSWORD!);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Нет интернета. Подключитесь и попробуйте снова.",
    );
    await expect(page).toHaveURL(/Login$/);
  });
}

test("the verification deadline includes refresh and ignores its late response", async ({
  page,
}) => {
  await signIn(page);
  await page.evaluate(() =>
    localStorage.setItem(
      "openride.driver.accessToken",
      "expired-test-access-token",
    ),
  );
  const originalRefresh = await page.evaluate(() =>
    localStorage.getItem("openride.driver.refreshToken"),
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/auth/refresh", async (route) => {
    // Delay the real server response, rather than manufacturing session payloads.
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Проверяем подключение…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Повторить подключение", exact: true }),
  ).toBeVisible({ timeout: 10000 });
  await expectLocked(page);
  release();
  // A timed-out request cannot unlock the workspace or replace saved tokens.
  await page.waitForTimeout(250);
  await expectLocked(page);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("openride.driver.refreshToken"),
    ),
  ).toBe(originalRefresh);
});

test("retry is single flight while connection events arrive", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/api/driver/profile", (route) =>
    route.abort("connectionfailed"),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Повторить подключение", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/driver/profile");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let requests = 0;
  await page.route("**/api/driver/profile", async (route) => {
    requests++;
    await gate;
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Повторить подключение", exact: true })
    .click();
  await expect(
    page.getByText("Проверяем подключение…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Повторить подключение", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(requests).toBe(1);
  release();
  await expect(
    page.getByRole("navigation", { name: "Разделы водителя" }),
  ).toBeVisible();
});

test("foreground return automatically retries a failed verification", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/api/driver/profile", (route) =>
    route.abort("connectionfailed"),
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Повторить подключение", exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/driver/profile");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(
    page.getByRole("navigation", { name: "Разделы водителя" }),
  ).toBeVisible();
});

test("signed out offline registration stays a local form without submitting an application", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    }),
  );
  let registrations = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/register")) registrations++;
  });
  await page.goto("/driverRegister");
  await page.getByLabel("Имя и фамилия").fill("Offline Applicant");
  await page.getByLabel("Номер телефона").fill("60000999");
  await page.getByLabel("Пароль", { exact: true }).fill("123456");
  await page
    .getByRole("button", { name: "Отправить заявку", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Нет интернета. Подключитесь и попробуйте снова.",
  );
  expect(registrations).toBe(0);
});

test("saved admin session shows the same immediate offline screen without mounting a dashboard", async ({
  page,
}) => {
  await page.goto("/adminLogin");
  await page.getByLabel("Номер телефона").fill("60000000");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.TEST_ACCOUNT_PASSWORD!);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Обзор", exact: true }),
  ).toBeVisible();
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    }),
  );
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/admin/")) requests++;
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("Нет интернета. Данные входа сохранены.", { exact: true }),
  ).toBeVisible({ timeout: 2000 });
  await expectLocked(page);
  expect(requests).toBe(0);
});
