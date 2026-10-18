import { test, expect, type Page } from "@playwright/test";
import { isolateBrowserClient } from "./helpers/device-session";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");
async function login(page: Page, phone = "60000101") {
  await isolateBrowserClient(page.context());
  await page.getByLabel("Номер телефона").fill(phone);
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.TEST_ACCOUNT_PASSWORD!);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/driverDashboard/);
}
async function start(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "openride.driver.deviceId",
      "synthetic-approved-browser",
    ),
  );
  await page.goto("/driverLogin");
  await login(page);
}
for (const failure of ["network", "server"] as const) {
  test(`a ${failure} failure during session restore keeps credentials locked behind a recoverable screen`, async ({
    page,
  }) => {
    await start(page);
    const original = await page.evaluate(() =>
      localStorage.getItem("openride.driver.refreshToken"),
    );
    await page.route("**/api/driver/profile", async (route) => {
      if (failure === "network") await route.abort("internetdisconnected");
      else
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: '{"message":"Temporary outage"}',
        });
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Повторить подключение", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Разделы водителя" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("openride.driver.refreshToken"),
      ),
    ).toBe(original);
    await page.unroute("**/api/driver/profile");
    await page
      .getByRole("button", { name: "Повторить подключение", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", { name: "Разделы водителя" }),
    ).toBeVisible();
    await expect(page).toHaveURL(/driverDashboard/);
  });
}
test("an old message request returning 401 cannot send as or sign out a replacement driver", async ({
  page,
}) => {
  await start(page);
  await page.getByRole("link", { name: "Чат", exact: true }).click();
  let release!: () => void;
  let reached!: () => void;
  const seen = new Promise<void>((resolve) => (reached = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let posts = 0;
  await page.route("**/api/driver/messages", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    reached();
    await gate;
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: '{"message":"Old session expired"}',
    });
  });
  await page
    .getByRole("textbox", { name: "Сообщение диспетчеру", exact: true })
    .fill("Must never be sent by replacement driver");
  await page
    .getByRole("button", { name: "Отправить сообщение", exact: true })
    .click();
  await seen;
  await page.getByRole("link", { name: "Профиль", exact: true }).click();
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page).toHaveURL(/driverLogin/);
  await login(page, "60000102");
  const replacement = await page.evaluate(() =>
    localStorage.getItem("openride.driver.accessToken"),
  );
  const delivered = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/driver/messages") &&
      response.request().method() === "POST" &&
      response.status() === 401,
  );
  release();
  await delivered;
  // Observe the retry window after the obsolete response reaches the client.
  // Keep interception installed so a forbidden replay is counted and rejected.
  await page.waitForTimeout(500);
  await expect(
    page.getByRole("navigation", { name: "Разделы водителя" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("openride.driver.accessToken"),
    ),
  ).toBe(replacement);
  expect(posts).toBe(1);
});
