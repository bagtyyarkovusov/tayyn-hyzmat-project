import { test, expect, type Page } from "@playwright/test";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");
const password = process.env.TEST_ACCOUNT_PASSWORD!;
async function login(
  page: Page,
  role: "admin" | "driver",
  driverPhone = "+10000000101",
) {
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
    .fill(role === "admin" ? "+10000000000" : driverPhone);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(
    role === "admin" ? /adminDashboard/ : /driverDashboard/,
  );
}
async function startGps(page: Page) {
  await page.context().grantPermissions(["geolocation"]);
  await page
    .context()
    .setGeolocation({ latitude: 37.96, longitude: 58.32, accuracy: 10 });
  const report = page.waitForResponse(
    (response) =>
      response.url().endsWith("/driver/location") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  expect((await report).ok()).toBe(true);
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
  await page.getByRole("button", { name: "Тема", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Тёмная" }).click();
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
  await page.getByRole("button", { name: "Тема", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Светлая" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
});
test("a driver must explicitly accept after five minutes, then completes a quoted trip for exactly 10 TMT", async ({
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
    await startGps(driver);
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      driver.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await driver.clock.install();
    let claimRequests = 0;
    driver.on("request", (request) => {
      if (new URL(request.url()).pathname.endsWith("/orders/accept"))
        claimRequests++;
    });
    await dispatcher.goto("/adminOrders");
    await dispatcher
      .getByRole("button", { name: "Создать заказ", exact: true })
      .click();
    const dialog = dispatcher.getByRole("dialog");
    await dialog
      .getByLabel("Район", { exact: true })
      .selectOption(process.env.TEST_REGION_ID!);
    await expect(dialog.getByLabel("Откуда", { exact: true })).toBeVisible();
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
    await driver.clock.fastForward(301000);
    expect(claimRequests).toBe(0);
    await expect(
      driver.getByRole("heading", { name: "Текущая поездка" }),
    ).not.toBeVisible();
    await expect(
      driver.getByRole("link", { name: "+10000000999", exact: true }),
    ).not.toBeVisible();
    await expect(driver.getByText(/500\s*TMT/).first()).toBeVisible();
    // Advancing the browser clock also expires GPS. Reacquire a real fix
    // before explicitly returning online and choosing the still-unclaimed order.
    await driver.clock.setSystemTime(new Date());
    await driver.reload();
    await startGps(driver);
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await driver
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: /Мой район/ })
      .click();
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
  // Exercise coordinate-entry fallback without calling the external map vendor.
  await page.route("https://api-maps.yandex.ru/**", (route) => route.abort());
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
    await driver.getByLabel("Сообщение диспетчеру").press("Enter");
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
    await dispatcher.getByLabel("Сообщение водителю").press("Enter");
    await expect(
      driver.getByText("Связь подтверждена", { exact: true }),
    ).toBeVisible();
    for (const [actor, label] of [
      [driver, "Сообщение диспетчеру"],
      [dispatcher, "Сообщение водителю"],
    ] as const) {
      const input = actor.getByLabel(label);
      await input.fill("Первая строка");
      await input.press("Shift+Enter");
      await input.press("End");
      await input.press("a");
      await expect(input).toHaveValue("Первая строка\na");
      await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
      await expect(input).toHaveValue("Первая строка\na");
      await input.fill("   ");
      await expect(
        actor.getByRole("button", { name: "Отправить сообщение", exact: true }),
      ).toBeDisabled();
      await input.fill("");
      for (const viewport of [
        { width: 320, height: 568 },
        { width: 390, height: 844 },
        { width: 568, height: 320 },
        { width: 390, height: 400 },
      ]) {
        await actor.setViewportSize(viewport);
        await expect
          .poll(() =>
            actor.evaluate(
              () =>
                document.documentElement.scrollHeight <= innerHeight &&
                document.documentElement.scrollWidth <= innerWidth,
            ),
          )
          .toBe(true);
        await expect
          .poll(async () => {
            const box = await input.boundingBox();
            return box!.y + box!.height;
          })
          .toBeLessThanOrEqual(viewport.height);
        await expect
          .poll(() =>
            input.evaluate((el) => {
              const inputBox = el.getBoundingClientRect();
              const buttonBox = el
                .closest("form")!
                .querySelector("button")!
                .getBoundingClientRect();
              return Math.abs(
                buttonBox.y +
                  buttonBox.height / 2 -
                  inputBox.y -
                  inputBox.height / 2,
              );
            }),
          )
          .toBeLessThan(2);
        const navigation = actor
          .getByRole("navigation", {
            name: actor === driver ? "Разделы водителя" : "Разделы диспетчера",
          })
          .last();
        await expect(navigation).toBeVisible();
        await expect
          .poll(() =>
            navigation.evaluate((el) => el.getBoundingClientRect().bottom),
          )
          .toBeLessThanOrEqual(viewport.height);
      }
    }
    await driver.setViewportSize({ width: 390, height: 844 });
    await dispatcher.setViewportSize({ width: 390, height: 844 });
    const failedDraft = "Черновик остаётся после ошибки";
    await driver.route("**/api/driver/messages", async (route) => {
      if (route.request().method() === "POST")
        await route.fulfill({
          status: 503,
          json: { message: "Тестовая ошибка доставки" },
        });
      else await route.continue();
    });
    await driver.getByLabel("Сообщение диспетчеру").fill(failedDraft);
    await driver.getByLabel("Сообщение диспетчеру").press("Enter");
    await expect(driver.getByRole("alert")).toBeVisible();
    await expect(driver.getByLabel("Сообщение диспетчеру")).toHaveValue(
      failedDraft,
    );
    await driver.unroute("**/api/driver/messages");
    await driver.getByLabel("Сообщение диспетчеру").press("Enter");
    await expect(
      dispatcher.getByText(failedDraft, { exact: true }),
    ).toBeVisible();
    await driver.reload();
    await expect(driver.getByText(failedDraft, { exact: true })).toBeVisible();
    let submits = 0;
    let release!: () => void;
    let received!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      received = resolve;
    });
    await driver.route("**/api/driver/messages", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      submits++;
      received();
      await held;
      await route.continue();
    });
    try {
      await driver
        .getByLabel("Сообщение диспетчеру")
        .fill("Одна отправка при двойном Enter");
      await driver.getByLabel("Сообщение диспетчеру").press("Enter");
      await reached;
      await driver.getByLabel("Сообщение диспетчеру").press("Enter");
      await expect(
        driver.getByRole("button", {
          name: "Отправить сообщение",
          exact: true,
        }),
      ).toBeDisabled();
    } finally {
      release();
    }
    await expect(
      dispatcher.getByText("Одна отправка при двойном Enter", { exact: true }),
    ).toBeVisible();
    expect(submits).toBe(1);
    await driver.unroute("**/api/driver/messages");

    // A long message exercises internal history scrolling through the real message endpoint.
    const longMessage = "История\n" + "Строка сообщения\n".repeat(40);
    await dispatcher.getByLabel("Сообщение водителю").fill(longMessage);
    await dispatcher.getByLabel("Сообщение водителю").press("Enter");
    await expect(
      driver.getByText(longMessage.trim(), { exact: true }),
    ).toBeVisible();
    const history = driver.getByRole("region", { name: "Переписка" });
    await history.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await dispatcher
      .getByLabel("Сообщение водителю")
      .fill("Новое сообщение без прыжка");
    await dispatcher.getByLabel("Сообщение водителю").press("Enter");
    await expect(
      driver.getByText("Новое сообщение без прыжка", { exact: true }),
    ).toBeAttached();
    await expect
      .poll(() => history.evaluate((el) => el.scrollTop))
      .toBeLessThan(10);
    const adminHistory = dispatcher.getByRole("region", { name: "Переписка" });
    await adminHistory.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await driver
      .getByLabel("Сообщение диспетчеру")
      .fill("Ответ без прокрутки истории диспетчера");
    await driver.getByLabel("Сообщение диспетчеру").press("Enter");
    await expect(
      dispatcher.getByText("Ответ без прокрутки истории диспетчера", {
        exact: true,
      }),
    ).toBeAttached();
    await expect
      .poll(() => adminHistory.evaluate((el) => el.scrollTop))
      .toBeLessThan(10);
    await adminHistory.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll"));
    });
    await driver
      .getByLabel("Сообщение диспетчеру")
      .fill("Ответ внизу истории диспетчера");
    await driver.getByLabel("Сообщение диспетчеру").press("Enter");
    await expect(
      dispatcher.getByText("Ответ внизу истории диспетчера", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        adminHistory.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(10);
    const adminInput = dispatcher.getByLabel("Сообщение водителю");
    await adminInput.fill("Первая строка\nВторая строка\nТретья строка");
    await expect
      .poll(() =>
        adminInput.evaluate((el) => {
          const input = el.getBoundingClientRect();
          const button = el
            .closest("form")!
            .querySelector("button")!
            .getBoundingClientRect();
          return Math.abs(
            button.y + button.height / 2 - input.y - input.height / 2,
          );
        }),
      )
      .toBeLessThan(2);
    await adminInput.press("Enter");
    await expect(
      driver.getByText("Первая строка\nВторая строка\nТретья строка", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(adminInput).toHaveValue("");
    await expect
      .poll(() =>
        dispatcher.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight,
        ),
      )
      .toBe(true);
    await driver.screenshot({ path: "test-results/driver-chat-mobile.png" });
    await dispatcher.screenshot({
      path: "test-results/dispatcher-chat-mobile.png",
    });
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
  test.setTimeout(60000);
  const context = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const page = await context.newPage();
  try {
    await login(page, "driver");
    const firstReport = page.waitForResponse(
      (response) =>
        response.url().endsWith("/driver/location") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await (await firstReport).finished();
    await expect(page.getByText(/GPS · точность 10 м/)).toBeVisible();
    const token = await page.evaluate(() =>
      localStorage.getItem("openride.driver.accessToken"),
    );
    await page
      .getByRole("navigation", { name: "Разделы водителя" })
      .getByRole("link", { name: "Профиль", exact: true })
      .click();
    // Native geolocation runs outside the browser timer mock. Let the real
    // reporting throttle expire before delivering each hardware location fix.
    await page.waitForTimeout(11000);
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
    // Native geolocation runs outside the browser timer mock. Let the real
    // reporting throttle expire before delivering each hardware location fix.
    await page.waitForTimeout(11000);
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
test("GPS is required to go online and can be retried after permission is granted", async ({
  browser,
}) => {
  test.setTimeout(45000);
  const context = await browser.newContext({
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const page = await context.newPage();
  try {
    await login(page, "driver");
    const power = page.getByRole("button", {
      name: "Выйти на линию",
      exact: true,
    });
    await expect(power).toBeDisabled();
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await expect(page.getByText(/Нет доступа к GPS/)).toBeVisible();
    await expect(power).toBeDisabled();
    await context.grantPermissions(["geolocation"]);
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await expect(page.getByText(/GPS · точность 10 м/)).toBeVisible();
    await expect(power).toBeEnabled();
    await power.click();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await context.clearPermissions();
    await expect(power).toBeVisible({ timeout: 30000 });
    await expect(power).toBeDisabled();
    await expect(
      page
        .getByRole("group", { name: "Регионы", exact: true })
        .getByRole("button")
        .first(),
    ).toBeDisabled();
  } finally {
    await context.close();
  }
});
test("switching driver account without logout clears the previous GPS session", async ({
  browser,
}) => {
  const context = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const page = await context.newPage();
  try {
    await login(page, "driver");
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await expect(page.getByText(/GPS · точность 10 м/)).toBeVisible();
    // Navigate through browser history without reloading the application singleton.
    await page.evaluate(() => {
      history.pushState({}, "", "/driverLogin");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByLabel("Номер телефона").fill("+10000000102");
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(/driverDashboard/);
    await expect(page.getByText(/GPS · точность/)).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toBeEnabled();
  } finally {
    await context.close();
  }
});
test("dispatcher enters region, phone and price and the region modal closes after driver acceptance", async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const dispatcher = await a.newPage(),
    driver = await b.newPage();
  try {
    await login(dispatcher, "admin");
    await login(driver, "driver", "+10000000102");
    await startGps(driver);
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      driver.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await dispatcher.goto("/adminOrders");
    await dispatcher
      .getByRole("button", { name: "Создать заказ", exact: true })
      .click();
    const dialog = dispatcher.getByRole("dialog");
    await dialog
      .getByLabel("Район", { exact: true })
      .selectOption(process.env.TEST_REGION_ID!);
    await expect(dialog.getByLabel("Телефон клиента")).toHaveValue("+993");
    await dialog.getByLabel("Телефон клиента").fill("+10000000888");
    await dialog.getByLabel("Стоимость, TMT").fill("15");
    await expect(dialog.getByLabel("Откуда", { exact: true })).toBeVisible();
    await dialog
      .getByRole("button", { name: "Отправить водителям", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(
      driver.getByText("Подача уточняется по телефону", { exact: true }),
    ).toBeVisible();
    await expect(
      driver.getByRole("link", { name: "+10000000888", exact: true }),
    ).not.toBeVisible();
    await driver
      .getByRole("button", { name: "Скрыть предложение", exact: true })
      .click();
    await driver.getByRole("button", { name: /ТЕСТ.*Центральный/ }).click();
    const regionOrders = driver.getByRole("dialog", {
      name: "Заказы района",
      exact: true,
    });
    await regionOrders
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await expect(regionOrders).not.toBeVisible();
    await expect(
      driver.getByRole("link", { name: "+10000000888", exact: true }),
    ).toBeVisible();
    await driver
      .getByRole("dialog", { name: "Управление поездкой", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 568, height: 320 },
    ]) {
      await driver.setViewportSize(viewport);
      expect(
        await driver.evaluate(
          () => document.documentElement.scrollHeight <= innerHeight,
        ),
      ).toBe(true);
      const cards = driver
        .getByRole("group", { name: "Регионы", exact: true })
        .getByRole("button");
      for (const card of await cards.all())
        await expect(card).toBeInViewport({ ratio: 1 });
      await expect(
        driver.getByRole("button", { name: "Поездка", exact: true }),
      ).toBeInViewport({ ratio: 1 });
    }
    await expect(
      driver
        .getByRole("group", { name: "Регионы", exact: true })
        .getByRole("button"),
    ).toHaveCount(9);
    await driver.getByRole("button", { name: "Поездка", exact: true }).click();
    for (const name of ["Я на месте", "Начать поездку", "Завершить поездку"])
      await driver.getByRole("button", { name, exact: true }).click();
    await driver.goto("/driverProfile");
    await expect(
      driver.getByText("485 TMT", { exact: true }).first(),
    ).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});

test("dispatcher adds an approved driver and opens their zero TMT balance", async ({
  page,
}) => {
  await login(page, "admin");
  await page.goto("/adminDrivers");
  await page
    .getByRole("button", { name: "Добавить водителя", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Телефон", { exact: true })).toHaveValue(
    "+993",
  );
  await dialog
    .getByLabel("Имя", { exact: true })
    .fill("Новый тестовый водитель");
  await dialog.getByLabel("Телефон", { exact: true }).fill("+99361999888");
  await dialog
    .getByLabel("Пароль", { exact: true })
    .fill("SyntheticBrowser123!");
  await expect(dialog.getByLabel("Район", { exact: true })).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Добавить водителя", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(page).toHaveURL(/adminDrivers\/[a-f0-9-]+/);
  await expect(
    page.getByRole("heading", { name: "Новый тестовый водитель", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Баланс", exact: true }).click();
  await expect(page.getByText("0 TMT", { exact: true }).first()).toBeVisible();
  await page.getByLabel("Сумма, TMT", { exact: true }).fill("100");
  await page.getByRole("button", { name: "Пополнить", exact: true }).click();
  await expect(
    page.getByText("100 TMT", { exact: true }).first(),
  ).toBeVisible();
});

test("all nine driver regions fit on the home screen without page scrolling", async ({
  page,
}) => {
  await login(page, "driver");
  await page.context().grantPermissions(["geolocation"]);
  await page
    .context()
    .setGeolocation({ latitude: 37.96, longitude: 58.32, accuracy: 10 });
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(page.getByText(/GPS · точность 10 м/)).toBeVisible();
  const regions = page.getByRole("group", { name: "Регионы", exact: true });
  await expect(regions.getByRole("button")).toHaveCount(9);
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 568, height: 320 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    for (const card of await regions.getByRole("button").all()) {
      await expect(card).toBeInViewport({ ratio: 1 });
      expect(
        await card.evaluate(
          (e) =>
            e.scrollHeight <= e.clientHeight && e.scrollWidth <= e.clientWidth,
        ),
      ).toBe(true);
    }
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollHeight <= innerHeight &&
          document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const grid = await regions.boundingBox();
    const nav = await page
      .getByRole("navigation", { name: "Разделы водителя" })
      .boundingBox();
    expect(grid!.y + grid!.height).toBeLessThanOrEqual(nav!.y);
  }
});

test("regional queues and counts recover through updates, reconnect and reload", async ({
  browser,
}) => {
  const a = await browser.newContext();
  const b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const dispatcher = await a.newPage();
  const driver = await b.newPage();
  try {
    await login(dispatcher, "admin");
    await login(driver, "driver", "+10000000103");
    await startGps(driver);
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      driver.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
    const power = driver.getByRole("button", {
      name: "Уйти с линии",
      exact: true,
      includeHidden: true,
    });
    await driver.mouse.move(0, 0);
    await expect(power).toHaveAttribute(
      "aria-description",
      "На линии. Связь с диспетчером установлена.",
    );
    await expect(power.locator(".online-beacon")).toHaveCSS(
      "animation-iteration-count",
      "infinite",
    );
    expect(await power.evaluate((el) => el.matches(":hover"))).toBe(false);
    const token = await dispatcher.evaluate(() =>
      localStorage.getItem("openride.admin.accessToken"),
    );
    const headers = { Authorization: `Bearer ${token}` };
    const regions = await (
      await dispatcher.request.get("/api/districts", { headers })
    ).json();
    const other = regions.find(
      (r: { id: string }) => r.id !== process.env.TEST_REGION_ID,
    );
    const card = driver
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: new RegExp(other.name) });
    await card.click();
    const queue = driver.getByRole("dialog", {
      name: "Заказы района",
      exact: true,
    });
    await expect(queue.getByText(/Сейчас нет свободных заказов/)).toBeVisible();
    async function create(pickupAddress: string) {
      const response = await dispatcher.request.post("/api/admin/orders", {
        headers,
        data: {
          districtId: other.id,
          clientPhone: "+10000000777",
          priceEstimated: 12,
          pickupAddress,
        },
      });
      expect(response.ok()).toBe(true);
      return response.json();
    }
    await create("Live remote pickup one");
    await expect(
      queue.getByText("Live remote pickup one", { exact: true }),
    ).toBeVisible();
    await queue.getByLabel("Буду через").selectOption("20");
    const second = await create("Live remote pickup two");
    await expect(
      queue.getByText("Live remote pickup two", { exact: true }),
    ).toBeVisible();
    await expect(queue.getByLabel("Буду через").first()).toHaveValue("20");
    expect(
      (
        await dispatcher.request.post(`/api/admin/orders/${second.id}/cancel`, {
          headers,
          data: {},
        })
      ).ok(),
    ).toBe(true);
    await expect(
      queue.getByText("Live remote pickup two", { exact: true }),
    ).not.toBeVisible();
    await expect(queue.getByLabel("Буду через")).toHaveValue("20");
    await b.setOffline(true);
    await expect(power).toHaveAttribute(
      "aria-description",
      "Нет связи с диспетчером. Переподключаемся.",
    );
    await expect(power.locator(".online-beacon")).toHaveCount(0);
    const third = await create("Live pickup while disconnected");
    await b.setOffline(false);
    await expect(power).toHaveAttribute(
      "aria-description",
      "На линии. Связь с диспетчером установлена.",
    );
    await expect(power.locator(".online-beacon")).toHaveCount(1);
    await expect(
      queue.getByText("Live pickup while disconnected", { exact: true }),
    ).toBeVisible();
    await expect(queue.getByLabel("Буду через").first()).toHaveValue("20");
    expect(
      (
        await dispatcher.request.post(`/api/admin/orders/${third.id}/cancel`, {
          headers,
          data: {},
        })
      ).ok(),
    ).toBe(true);
    await expect(
      queue.getByText("Live pickup while disconnected", { exact: true }),
    ).not.toBeVisible();
    await queue
      .getByRole("button", { name: "Принять заказ", exact: true })
      .click();
    await expect(queue).not.toBeVisible();
    await expect(
      driver.getByRole("link", { name: "+10000000777", exact: true }),
    ).toBeVisible();
    await driver.reload();
    const trip = driver.getByRole("dialog", {
      name: "Управление поездкой",
      exact: true,
    });
    await expect(
      trip.getByText("Live remote pickup one", { exact: true }),
    ).toBeVisible();
    await expect(
      trip.getByText("Прибытие: 20 мин", { exact: true }),
    ).toBeVisible();
    await trip.getByRole("button", { name: "Close", exact: true }).click();
    await expect(driver.getByLabel("Тестовый баланс")).toHaveText("488 TMT");
    await driver.screenshot({
      path: "test-results/driver-live-trip-strip.png",
      animations: "disabled",
    });
    await driver.emulateMedia({ reducedMotion: "reduce" });
    await driver.getByRole("button", { name: "Поездка", exact: true }).click();
    await driver.screenshot({ path: "test-results/driver-trip-dialog.png" });
    for (const name of ["Я на месте", "Начать поездку", "Завершить поездку"])
      await driver.getByRole("button", { name, exact: true }).click();
    await expect(driver.getByLabel("Тестовый баланс")).toHaveText("488 TMT");
    await startGps(driver);
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await test.step("an older HTTP snapshot cannot replace newer live counts", async () => {
      let release = () => {};
      try {
        await expect(card.getByText("0:0", { exact: true })).toBeVisible();
        let captured = () => {};
        const ready = new Promise<void>((r) => {
          captured = r;
        });
        const held = new Promise<void>((r) => {
          release = r;
        });
        await driver.route(
          "**/api/districts",
          async (route) => {
            const response = await route.fetch();
            captured();
            await held;
            await route.fulfill({ response });
          },
          { times: 1 },
        );
        await driver.bringToFront();
        await driver.evaluate(() =>
          document.dispatchEvent(new Event("visibilitychange")),
        );
        await ready;
        const response = await dispatcher.request.post("/api/admin/orders", {
          headers,
          data: {
            districtId: other.id,
            clientPhone: "+10000000777",
            priceEstimated: 12,
          },
        });
        expect(response.ok()).toBe(true);
        const order = await response.json();
        await expect(card.getByText("0:1", { exact: true })).toBeVisible();
        const refreshed = driver.waitForResponse("**/api/districts");
        release();
        await (await refreshed).finished();
        await driver.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        await expect(card.getByText("0:1", { exact: true })).toBeVisible();
        expect(
          (
            await dispatcher.request.post(
              `/api/admin/orders/${order.id}/cancel`,
              {
                headers,
                data: {},
              },
            )
          ).ok(),
        ).toBe(true);
        await expect(card.getByText("0:0", { exact: true })).toBeVisible();
      } finally {
        release();
      }
    });
  } finally {
    await a.close();
    await b.close();
  }
});
