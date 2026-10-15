import { test, expect, type Page } from "@playwright/test";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");
const password = process.env.TEST_ACCOUNT_PASSWORD!;
async function login(page: Page, role: "admin" | "driver") {
  if (role === "driver")
    await page.addInitScript(() =>
      localStorage.setItem(
        "openride.driver.deviceId",
        "synthetic-approved-browser",
      ),
    );
  await page.goto(role === "admin" ? "/adminLogin" : "/driverLogin");
  await page
    .getByLabel("Номер телефона")
    .fill(role === "admin" ? "+10000000000" : "+10000000101");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(
    role === "admin" ? /adminDashboard/ : /driverDashboard/,
  );
}
test("protected deep links require login and a failed login gives a recoverable error", async ({
  page,
}) => {
  await page.goto("/adminOrders");
  await expect(page).toHaveURL(/adminLogin/);
  await page.getByLabel("Номер телефона").fill("+10000000000");
  await page.getByLabel("Пароль", { exact: true }).fill("wrong-password");
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Войти", exact: true }),
  ).toBeEnabled();
});
test("theme preference survives a refreshed deep link and mobile navigation stays usable", async ({
  page,
}) => {
  await login(page, "admin");
  await page.getByLabel("Тема", { exact: true }).selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.goto("/adminOrders");
  await page.reload();
  await expect(page).toHaveURL(/adminOrders/);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page
      .getByRole("navigation", { name: "Разделы диспетчера" })
      .last()
      .getByRole("link", { name: "Регионы", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Тема", { exact: true }).selectOption("light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
});
test("dispatcher order reaches an online driver, progresses to completion and debits exactly 10 TMT", async ({
  browser,
}) => {
  const dispatchContext = await browser.newContext();
  const driverContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const dispatcher = await dispatchContext.newPage();
  const driver = await driverContext.newPage();
  try {
    await login(dispatcher, "admin");
    await login(driver, "driver");
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      driver.getByText("Вы принимаете заказы", { exact: true }),
    ).toBeVisible();
    await dispatcher.goto("/adminOrders");
    await dispatcher
      .getByRole("button", { name: "Создать заказ", exact: true })
      .click();
    const dialog = dispatcher.getByRole("dialog");
    await dialog
      .getByLabel("Район", { exact: true })
      .selectOption(process.env.TEST_REGION_ID!);
    await dialog
      .getByLabel("Откуда", { exact: true })
      .fill("Тестовая улица 10");
    await dialog.getByLabel("Куда", { exact: true }).fill("Тестовая улица 20");
    await dialog.getByLabel("Телефон клиента").fill("+10000000999");
    await dialog.getByLabel("Стоимость, TMT").fill("10");
    await dialog
      .getByRole("button", { name: "Отправить водителям", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      driver.getByText("Тестовая улица 10", { exact: true }),
    ).toBeVisible();
    await driver
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await expect(
      driver.getByRole("heading", { name: "Текущая поездка" }),
    ).toBeVisible();
    await expect(
      driver.getByRole("link", { name: "+10000000999", exact: true }),
    ).toBeVisible();
    await driver
      .getByRole("button", { name: "Я на месте", exact: true })
      .click();
    await driver
      .getByRole("button", { name: "Начать поездку", exact: true })
      .click();
    await driver
      .getByRole("button", { name: "Завершить поездку", exact: true })
      .click();
    await expect(
      driver.getByRole("heading", { name: "Текущая поездка" }),
    ).not.toBeVisible();
    await driver.goto("/driverProfile");
    await expect(driver.getByText(/490\s*TMT/).first()).toBeVisible();
    await dispatcher
      .getByRole("button", { name: "Завершённые", exact: true })
      .click();
    await expect(
      dispatcher.getByText("Тестовая улица 10", { exact: true }),
    ).toBeVisible();
    await driver.screenshot({
      path: "test-results/driver-mobile-profile.png",
      fullPage: true,
    });
    await dispatcher.screenshot({
      path: "test-results/dispatcher-desktop-orders.png",
      fullPage: true,
    });
  } finally {
    await dispatchContext.close();
    await driverContext.close();
  }
});
test("saved synthetic region coordinates survive reload and invalid drafts do not overwrite them", async ({
  page,
}) => {
  await login(page, "admin");
  await page.goto("/adminDistricts/boundaries");
  await expect(
    page.getByLabel("Контуры: массив точек [широта, долгота]"),
  ).toBeVisible();
  const field = page.getByLabel("Контуры: массив точек [широта, долгота]");
  await field.fill(
    "[[[37.941,58.301],[37.979,58.301],[37.979,58.359],[37.941,58.359],[37.941,58.301]]]",
  );
  await page
    .getByRole("button", { name: "Сохранить границу", exact: true })
    .click();
  await expect(
    page.getByText("Граница сохранена на сервере.", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByLabel("Контуры: массив точек [широта, долгота]"),
  ).toBeVisible();
  await expect
    .poll(async () => JSON.parse(await field.inputValue())[0][0])
    .toEqual([37.941, 58.301]);
  await field.fill("[[[999,58]]]");
  await page
    .getByRole("button", { name: "Сохранить границу", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page
    .getByRole("button", { name: "Отменить правки", exact: true })
    .click();
  await expect
    .poll(async () => JSON.parse(await field.inputValue())[0][0])
    .toEqual([37.941, 58.301]);
  await page.screenshot({
    path: "test-results/dispatcher-boundary-editor.png",
    fullPage: true,
  });
});
test("driver and dispatcher exchange real messages across separate role sessions", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const dispatcher = await a.newPage(),
    driver = await b.newPage();
  try {
    await login(dispatcher, "admin");
    await login(driver, "driver");
    await driver.goto("/driverChat");
    await driver
      .getByLabel("Сообщение диспетчеру")
      .fill("Тестовая связь с диспетчером");
    await driver
      .getByRole("button", { name: "Отправить", exact: true })
      .click();
    await expect(
      driver.getByText("Тестовая связь с диспетчером", { exact: true }),
    ).toBeVisible();
    await dispatcher.goto("/adminChat");
    await dispatcher
      .getByText("Тестовый водитель", { exact: true })
      .first()
      .click();
    await expect(
      dispatcher.getByText("Тестовая связь с диспетчером", { exact: true }),
    ).toBeVisible();
    await dispatcher
      .getByLabel("Сообщение водителю")
      .fill("Связь подтверждена");
    await dispatcher
      .getByRole("button", { name: "Отправить сообщение", exact: true })
      .click();
    await expect(
      driver.getByText("Связь подтверждена", { exact: true }),
    ).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});
test("logout wins over a delayed refresh response and keeps the other actor signed in", async ({
  page,
}) => {
  await login(page, "admin");
  await login(page, "driver");
  let release!: () => void;
  let seen!: () => void;
  const reached = new Promise<void>((resolve) => (seen = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/auth/refresh", async (route) => {
    const response = await route.fetch();
    seen();
    await gate;
    await route.fulfill({ response });
  });
  await page.evaluate(() =>
    localStorage.setItem("openride.driver.accessToken", "expired-test-token"),
  );
  await page
    .getByRole("navigation", { name: "Разделы водителя" })
    .getByRole("link", { name: "Профиль", exact: true })
    .click();
  await reached;
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await expect(page).toHaveURL(/driverLogin/);
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("openride.driver.accessToken")),
    )
    .toBeNull();
  await page.goto("/adminOrders");
  await expect(page).toHaveURL(/adminOrders/);
});
test("GPS reporting continues across driver routes and stops after logout", async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const page = await context.newPage();
  try {
    await login(page, "driver");
    await page.clock.install();
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await expect(page.getByText(/GPS · точность 10 м/)).toBeVisible();
    const token = await page.evaluate(() =>
      localStorage.getItem("openride.driver.accessToken"),
    );
    await page
      .getByRole("navigation", { name: "Разделы водителя" })
      .getByRole("link", { name: "Профиль", exact: true })
      .click();
    await page.clock.fastForward(11000);
    await context.setGeolocation({
      latitude: 37.9701,
      longitude: 58.3301,
      accuracy: 10,
    });
    await expect
      .poll(async () => {
        const response = await context.request.get(
          `${process.env.TEST_API_URL}/driver/profile`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        return Number((await response.json()).lastLat);
      })
      .toBe(37.9701);
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/driverLogin/);
    await page.clock.fastForward(11000);
    await context.setGeolocation({
      latitude: 37.98,
      longitude: 58.34,
      accuracy: 10,
    });
    const response = await context.request.get(
      `${process.env.TEST_API_URL}/driver/profile`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(Number((await response.json()).lastLat)).toBe(37.9701);
  } finally {
    await context.close();
  }
});
