import { test, expect, type Page, type BrowserContext } from "@playwright/test";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");
const password = process.env.TEST_ACCOUNT_PASSWORD!;
const browserClients = new WeakMap<BrowserContext, string>();
let nextBrowserClient = 1;
async function isolateBrowserClient(page: Page) {
  const context = page.context();
  if (browserClients.has(context)) return;
  // Vite proxies all browsers through loopback. Model each browser as a
  // distinct client without weakening the API's production auth limiter.
  const address = `198.18.${process.pid % 200}.${nextBrowserClient++}`;
  browserClients.set(context, address);
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": address });
}
async function login(
  page: Page,
  role: "admin" | "driver",
  driverPhone = "+99360000101",
) {
  await isolateBrowserClient(page);
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
    .fill(role === "admin" ? "+99360000000" : driverPhone);
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
test("phone entry groups local digits and preserves middle edits and separator deletion", async ({
  page,
}) => {
  await page.goto("/driverLogin");
  const phone = page.getByLabel("Номер телефона", { exact: true });
  await phone.pressSequentially("65995424");
  await expect(phone).toHaveValue("65 99 54 24");
  // Replace a middle digit through the native selection interface.
  await phone.evaluate((node: HTMLInputElement) =>
    node.setSelectionRange(3, 4),
  );
  await phone.pressSequentially("8");
  await expect(phone).toHaveValue("65 89 54 24");
  expect(
    await phone.evaluate((node: HTMLInputElement) => node.selectionStart),
  ).toBe(4);
  // Backspace immediately after a generated space deletes the preceding digit.
  await phone.evaluate((node: HTMLInputElement) =>
    node.setSelectionRange(3, 3),
  );
  await phone.press("Backspace");
  await expect(phone).toHaveValue("68 95 42 4");
  expect(
    await phone.evaluate((node: HTMLInputElement) => node.selectionStart),
  ).toBe(1);
  // Delete immediately before a generated space deletes the following digit.
  await phone.fill("65 99 54 24");
  await phone.evaluate((node: HTMLInputElement) =>
    node.setSelectionRange(2, 2),
  );
  await phone.press("Delete");
  await expect(phone).toHaveValue("65 95 42 4");
  expect(
    await phone.evaluate((node: HTMLInputElement) => node.selectionStart),
  ).toBe(2);
  await phone.fill("00993 65-99-54-24");
  await expect(phone).toHaveValue("65 99 54 24");
  await phone.press("ControlOrMeta+A");
  await phone.press("Backspace");
  await expect(phone).toHaveValue("");
  await expect(phone).toHaveAttribute("placeholder", "Номер телефона");
  await expect(page.getByText("+993", { exact: true })).toBeVisible();
});
test("phone country prefix stays fixed while login accepts local digits and canonical paste", async ({
  page,
}) => {
  await isolateBrowserClient(page);
  await page.goto("/adminLogin");
  const phone = page.getByLabel("Номер телефона", { exact: true });
  await expect(phone).toHaveValue("");
  await expect(page.getByText("+993", { exact: true })).toBeVisible();
  await phone.fill("+447700900123");
  await expect(phone).toHaveAttribute("aria-invalid", "true");
  await phone.fill("+99360000000");
  await expect(phone).toHaveValue("60 00 00 00");
  await phone.press("ControlOrMeta+A");
  await phone.press("Backspace");
  await expect(phone).toHaveValue("");
  await expect(page.getByText("+993", { exact: true })).toBeVisible();
  await phone.fill("60000000");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/adminDashboard/);
});
test("driver registration validates a complete local phone and accepts a six-digit password", async ({
  page,
}) => {
  await isolateBrowserClient(page);
  await page.goto("/driverRegister");
  const phone = page.getByLabel("Номер телефона", { exact: true });
  await page.getByLabel("Имя и фамилия").fill("Регистрация с местным номером");
  for (const invalid of ["+993619998877", "not-a-phone", "+447700900123"]) {
    await phone.fill(invalid);
    await expect(phone).toHaveValue(invalid);
    await expect(phone).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByRole("alert")).toContainText(
      "Введите 8 цифр номера после +993",
    );
  }
  await phone.fill("61 999887");
  await expect(phone).toHaveValue("61 99 98 87");
  await page.getByLabel("Пароль", { exact: true }).fill("ж".repeat(37));
  await page
    .getByRole("button", { name: "Отправить заявку", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("максимум 72 байта");
  await page.getByLabel("Пароль", { exact: true }).fill("123456");
  const registration = page.waitForResponse(
    (response) =>
      response.url().endsWith("/auth/register") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Отправить заявку", exact: true })
    .click();
  expect((await registration).status()).toBe(201);
  await expect(page.getByRole("status")).toContainText("Заявка отправлена");
});
test("protected deep links require login and a failed login gives a recoverable error", async ({
  page,
}) => {
  await page.goto("/adminOrders");
  await expect(page).toHaveURL(/adminLogin/);
  await page.getByLabel("Номер телефона").fill("+99360000000");
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
    await dialog.getByLabel("Телефон клиента").fill("+99360000999");
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
      driver.getByRole("link", { name: "+993 60 00 09 99", exact: true }),
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
      driver.getByRole("link", { name: "+993 60 00 09 99", exact: true }),
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
    await expect(
      driver.getByRole("button", { name: "Обновить сообщения" }),
    ).toHaveCount(0);
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
test("driver history hides single-page navigation and resets the page when switching history", async ({
  page,
}) => {
  await login(page, "admin");
  const adminToken = await page.evaluate(() =>
    localStorage.getItem("openride.admin.accessToken"),
  );
  const create = await page.request.post(
    `${process.env.TEST_API_URL}/admin/drivers`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: {
        fullName: "История без поездок",
        phone: "+99360000301",
        password,
      },
    },
  );
  expect(create.ok()).toBe(true);
  await login(page, "driver", "+99360000301");
  const driverToken = await page.evaluate(() =>
    localStorage.getItem("openride.driver.accessToken"),
  );
  const headers = { Authorization: `Bearer ${adminToken}` };
  const profile = await page.request.get(
    `${process.env.TEST_API_URL}/driver/profile`,
    { headers: { Authorization: `Bearer ${driverToken}` } },
  );
  const driverId = (await profile.json()).id;
  await page.goto("/driverProfile");
  await expect(
    page.getByText("Поездок пока нет.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Далее", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Баланс", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Далее", exact: true }),
  ).toHaveCount(0);
  for (let i = 0; i < 21; i++) {
    const response = await page.request.post(
      `${process.env.TEST_API_URL}/admin/drivers/${driverId}/balance`,
      {
        headers,
        data: { amount: 1, type: "TOPUP", note: `Проверка страниц ${i}` },
      },
    );
    expect(response.ok()).toBe(true);
  }
  await page.reload();
  await page.getByRole("button", { name: "Баланс", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Далее", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(page.getByText("Страница 2", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Назад", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Поездки", exact: true }).click();
  await expect(
    page.getByText("Поездок пока нет.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Страница 2", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Баланс", exact: true }).click();
  await expect(page.getByText("Страница 1", { exact: true })).toBeVisible();
});
test("chat reconnect recovers more than fifty missed messages without losing the draft", async ({
  browser,
}) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const dispatcher = await a.newPage();
    const driver = await b.newPage();
    await login(dispatcher, "admin");
    await login(driver, "driver");
    await driver.goto("/driverChat");
    const composer = driver.getByLabel("Сообщение диспетчеру");
    await composer.fill("Последнее известное сообщение");
    await composer.press("Enter");
    await expect(
      driver.getByText("Последнее известное сообщение", { exact: true }),
    ).toBeVisible();
    await composer.fill("Сохранённый черновик");
    await b.setOffline(true);
    const adminToken = await dispatcher.evaluate(() =>
      localStorage.getItem("openride.admin.accessToken"),
    );
    const driverToken = await driver.evaluate(() =>
      localStorage.getItem("openride.driver.accessToken"),
    );
    const profile = await a.request.get(
      `${process.env.TEST_API_URL}/driver/profile`,
      { headers: { Authorization: `Bearer ${driverToken}` } },
    );
    const driverId = (await profile.json()).id;
    for (let i = 0; i < 55; i++) {
      const response = await a.request.post(
        `${process.env.TEST_API_URL}/admin/messages`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
          data: { driverId, body: `Пропущенное сообщение ${i}` },
        },
      );
      expect(response.ok()).toBe(true);
    }
    await b.setOffline(false);
    await expect(
      driver.getByText("Пропущенное сообщение 54", { exact: true }),
    ).toBeAttached();
    await expect(
      driver.getByText("Пропущенное сообщение 0", { exact: true }),
    ).toBeAttached();
    await expect(composer).toHaveValue("Сохранённый черновик");
    await expect(
      driver.getByRole("button", { name: "Обновить сообщения" }),
    ).toHaveCount(0);
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
    await page.getByLabel("Номер телефона").fill("+99360000102");
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
    await login(driver, "driver", "+99360000102");
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
    await expect(dialog.getByLabel("Телефон клиента")).toHaveValue("");
    await expect(dialog.getByText("+993", { exact: true })).toBeVisible();
    await dialog.getByLabel("Телефон клиента").fill("+99360000888");
    await expect(dialog.getByLabel("Телефон клиента")).toHaveValue(
      "60 00 08 88",
    );
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
      driver.getByRole("link", { name: "+993 60 00 08 88", exact: true }),
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
      driver.getByRole("link", { name: "+993 60 00 08 88", exact: true }),
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
  await expect(dialog.getByLabel("Телефон", { exact: true })).toHaveValue("");
  await expect(dialog.getByText("+993", { exact: true })).toBeVisible();
  await dialog
    .getByLabel("Имя", { exact: true })
    .fill("Новый тестовый водитель");
  await dialog.getByLabel("Телефон", { exact: true }).fill("61999888");
  await dialog.getByLabel("Пароль", { exact: true }).fill("123456");
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

async function openCredentialFixture(page: Page, phone: string) {
  // Model a separate dispatcher device rather than exhausting the shared
  // loopback IP's production auth limit across unrelated browser scenarios.
  await page.context().setExtraHTTPHeaders({
    "X-Forwarded-For": `192.0.2.${phone.slice(-2)}`,
  });
  const session = await page.request.post(
    `${process.env.TEST_API_URL}/auth/login`,
    {
      data: { phone: "+99360000000", password },
    },
  );
  const { accessToken } = await session.json();
  const created = await page.request.post(
    `${process.env.TEST_API_URL}/admin/drivers`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { fullName: "Credential browser fixture", phone, password },
    },
  );
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await login(page, "admin");
  await page.goto(`/adminDrivers/${id}`);
}
test("dispatcher edits driver name and login phone", async ({ page }) => {
  await openCredentialFixture(page, "+99361999890");
  await page
    .getByRole("button", { name: "Изменить данные входа", exact: true })
    .click();
  await page
    .getByLabel("Имя водителя", { exact: true })
    .fill("Изменённый водитель");
  await page
    .getByLabel("Номер телефона", { exact: true })
    .fill("0099361999889");
  await expect(page.getByLabel("Номер телефона", { exact: true })).toHaveValue(
    "61 99 98 89",
  );
  await page
    .getByRole("button", { name: "Сохранить данные", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Изменённый водитель", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "+993 61 99 98 89", exact: true }),
  ).toBeVisible();
});
test("dispatcher confirms password reset and the closed form forgets its password", async ({
  page,
}) => {
  await openCredentialFixture(page, "+99361999891");
  await page
    .getByRole("button", { name: "Сбросить пароль", exact: true })
    .click();
  await page.getByLabel("Новый пароль", { exact: true }).fill("123456");
  await page
    .getByLabel("Повторите пароль", { exact: true })
    .fill("Different123!");
  await page
    .getByRole("button", { name: "Изменить пароль", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Пароли не совпадают");
  await page.getByLabel("Повторите пароль", { exact: true }).fill("123456");
  await page
    .getByRole("button", { name: "Изменить пароль", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page
    .getByRole("button", { name: "Сбросить пароль", exact: true })
    .click();
  await expect(page.getByLabel("Новый пароль", { exact: true })).toHaveValue(
    "",
  );
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
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
    await login(driver, "driver", "+99360000103");
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
          clientPhone: "+99360000777",
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
      driver.getByRole("link", { name: "+993 60 00 07 77", exact: true }),
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
    await expect(driver.getByLabel("Баланс")).toHaveText("488 TMT");
    await driver.screenshot({
      path: "test-results/driver-live-trip-strip.png",
      animations: "disabled",
    });
    await driver.emulateMedia({ reducedMotion: "reduce" });
    await driver.getByRole("button", { name: "Поездка", exact: true }).click();
    await driver.screenshot({ path: "test-results/driver-trip-dialog.png" });
    for (const name of ["Я на месте", "Начать поездку", "Завершить поездку"])
      await driver.getByRole("button", { name, exact: true }).click();
    await expect(driver.getByLabel("Баланс")).toHaveText("488 TMT");
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
            clientPhone: "+99360000777",
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

test("a transient GPS timeout keeps its blocker visible until an explicit retry receives a fresh server-acknowledged fix", async ({
  page,
}) => {
  // A separate synthetic client exercises recovery without exhausting the login limiter used by earlier workflows.
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "127.0.0.79" });
  await page.context().grantPermissions(["geolocation"]);
  await page.addInitScript(() => {
    let watch: PositionCallback | undefined;
    let failure: PositionErrorCallback | null | undefined;
    const position = () =>
      ({
        coords: {
          latitude: 37.96,
          longitude: 58.32,
          accuracy: 10,
          heading: null,
          speed: null,
          altitude: null,
          altitudeAccuracy: null,
        },
        timestamp: Date.now(),
      }) as GeolocationPosition;
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        watchPosition(
          success: PositionCallback,
          failed?: PositionErrorCallback,
        ) {
          watch = success;
          failure = failed;
          setTimeout(() => watch?.(position()), 0);
          return 1;
        },
        clearWatch() {
          watch = undefined;
        },
        getCurrentPosition(success: PositionCallback) {
          setTimeout(() => success(position()), 1500);
        },
      },
    });
    window.addEventListener("synthetic-gps-timeout", () =>
      failure?.({
        code: 3,
        message: "Synthetic hardware timeout",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      }),
    );
  });
  await login(page, "driver");
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  const power = page.getByRole("button", {
    name: "Выйти на линию",
    exact: true,
  });
  await expect(power).toBeEnabled();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("synthetic-gps-timeout")),
  );
  await expect(power).toBeDisabled();
  await expect(
    page.getByText(/GPS.*(?:временно недоступен|не ответил)/).first(),
  ).toBeAttached();
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(
    page.getByText(/GPS.*(?:временно недоступен|не ответил)/).first(),
  ).toBeAttached();
  await expect(power).toBeDisabled();
  await expect(power).toBeEnabled({ timeout: 5000 });
  await expect(page.getByText(/GPS · точность 10 м/)).toBeVisible();
});

async function emulateNativeBridge(page: Page, holdPermission: boolean) {
  await page.addInitScript((holdPermission) => {
    const bridge = window as unknown as {
      CapacitorCustomPlatform: { name: string };
      Capacitor: unknown;
      releaseNativePermission?: () => void;
      holdNativePermission: boolean;
      holdNativeStart?: boolean;
      releaseNativeStart?: () => void;
      activeNativeUser?: string;
      syntheticNativeStopped?: boolean;
      syntheticNativeStopSequence?: number;
      syntheticNativeStopAfterPermission?: boolean;
    };
    bridge.holdNativePermission = holdPermission;
    bridge.CapacitorCustomPlatform = { name: "android" };
    const status = {
      running: false,
      phase: "off",
      userId: "",
      lastReportAt: 0,
      detail: "",
      stopSequence: 0,
    };
    let activeToken = "";
    bridge.Capacitor = {
      PluginHeaders: [
        {
          name: "DriverShift",
          methods: [
            "permissions",
            "status",
            "location",
            "stop",
            "clear",
            "notificationTarget",
            "start",
          ].map((name) => ({ name, rtype: "promise" })),
        },
      ],
      nativePromise: async (
        _plugin: string,
        method: string,
        options?: { shiftToken?: string; userId?: string },
      ) => {
        if (method === "start") {
          activeToken = options?.shiftToken || "";
          bridge.activeNativeUser = options?.userId;
          if (bridge.holdNativeStart)
            return new Promise<void>((resolve) => {
              bridge.releaseNativeStart = resolve;
            });
          return {};
        }
        if (method === "stop") {
          if (!options?.shiftToken || options.shiftToken === activeToken) {
            activeToken = "";
            bridge.activeNativeUser = "";
          }
          return {};
        }
        if (method === "permissions" && !bridge.holdNativePermission) {
          if (bridge.syntheticNativeStopAfterPermission)
            bridge.syntheticNativeStopped = true;
          return {
            ...status,
            stopSequence: bridge.syntheticNativeStopped
              ? (bridge.syntheticNativeStopSequence ?? 1)
              : 0,
            locationGranted: true,
            ordersEnabled: true,
            chatEnabled: true,
          };
        }
        if (method === "permissions")
          return new Promise((resolve) => {
            bridge.releaseNativePermission = () =>
              resolve({
                locationGranted: true,
                ordersEnabled: true,
                chatEnabled: true,
              });
          });
        if (method === "location")
          return { lat: 0, lng: 0, accuracy: 10, timestamp: Date.now() };
        if (method === "status")
          return bridge.syntheticNativeStopped
            ? {
                ...status,
                detail: "Смена завершена сервером",
                stopSequence: bridge.syntheticNativeStopSequence ?? 1,
              }
            : status;
        return {};
      },
    };
  }, holdPermission);
}

test("an offline native driver sees the healthy dispatcher connection before starting a shift", async ({
  page,
}) => {
  await emulateNativeBridge(page, false);
  await login(page, "driver");
  await expect(
    page.getByText("Переподключаемся к диспетчеру…", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeEnabled();
});

test("a stopped native shift does not erase a newly confirmed GPS fix on later status reconciliation", async ({
  page,
}) => {
  await emulateNativeBridge(page, false);
  await page.addInitScript(() => {
    (
      window as unknown as { syntheticNativeStopped: boolean }
    ).syntheticNativeStopped = true;
  });
  await login(page, "driver");
  await expect(
    page.getByText("Смена завершена сервером", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeEnabled();
  await page.getByRole("link", { name: "Профиль", exact: true }).click();
  await page.getByRole("link", { name: "Заказы", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText("Смена завершена сервером", { exact: true }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    (
      window as unknown as { syntheticNativeStopSequence: number }
    ).syntheticNativeStopSequence = 2;
  });
  await page.getByRole("link", { name: "Профиль", exact: true }).click();
  await page.getByRole("link", { name: "Заказы", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("Смена завершена сервером", { exact: true }),
  ).toBeVisible();
});

test("explicit native GPS acknowledges an old stop before its next status poll", async ({
  page,
}) => {
  await emulateNativeBridge(page, false);
  await login(page, "driver");
  await page.evaluate(() => {
    (
      window as unknown as { syntheticNativeStopAfterPermission: boolean }
    ).syntheticNativeStopAfterPermission = true;
  });
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeEnabled();
  await page.getByRole("link", { name: "Профиль", exact: true }).click();
  await page.getByRole("link", { name: "Заказы", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeEnabled();
});

test("a native GPS permission callback from a previous driver cannot post the next driver's location", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "127.0.0.80" });
  await emulateNativeBridge(page, true);
  await login(page, "driver");
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { releaseNativePermission?: unknown })
            .releaseNativePermission,
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    history.pushState({}, "", "/driverLogin");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByLabel("Номер телефона").fill("+99360000102");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/driverDashboard/);
  let locationPosted = false;
  await page.route("**/driver/location", async (route) => {
    locationPosted = true;
    await route.continue();
  });
  await page.evaluate(() =>
    (
      window as unknown as { releaseNativePermission: () => void }
    ).releaseNativePermission(),
  );
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toBeEnabled();
  // Wait for the released bridge promise and resulting network work to settle.
  await page.waitForTimeout(300);
  expect(locationPosted).toBe(false);
  await expect(page.getByText(/GPS · точность/)).toHaveCount(0);
});

test("a cancelled native Online operation cannot offline a newly signed-in driver", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "127.0.0.81" });
  await emulateNativeBridge(page, false);
  await login(page, "driver");
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(page.getByText(/GPS · точность 10 м/)).toBeVisible();
  await page.evaluate(() => {
    (
      window as unknown as { holdNativePermission: boolean }
    ).holdNativePermission = true;
  });
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { releaseNativePermission?: unknown })
            .releaseNativePermission,
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    history.pushState({}, "", "/driverLogin");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByLabel("Номер телефона").fill("+99360000102");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/driverDashboard/);
  let statusPosted = false;
  await page.route("**/driver/status", async (route) => {
    statusPosted = true;
    await route.continue();
  });
  await page.evaluate(() =>
    (
      window as unknown as { releaseNativePermission: () => void }
    ).releaseNativePermission(),
  );
  await page.waitForTimeout(300);
  expect(statusPosted).toBe(false);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a delayed native start from the old account cannot stop the new account's shift", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "127.0.0.82" });
  await emulateNativeBridge(page, false);
  await login(page, "driver", "+99360000103");
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(page.getByText(/GPS · точность 10 м/)).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { holdNativeStart: boolean }).holdNativeStart = true;
  });
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(
          (window as unknown as { releaseNativeStart?: unknown })
            .releaseNativeStart,
        ),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    history.pushState({}, "", "/driverLogin");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.getByLabel("Номер телефона").fill("+99360000102");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/driverDashboard/);
  await page.evaluate(() => {
    (window as unknown as { holdNativeStart: boolean }).holdNativeStart = false;
  });
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(page.getByText(/GPS · точность 10 м/)).toBeVisible();
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  const currentUser = await page.evaluate(
    () => JSON.parse(localStorage.getItem("tayyn.driver.user")!).id as string,
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { activeNativeUser?: string }).activeNativeUser,
      ),
    )
    .toBe(currentUser);
  await page.evaluate(() =>
    (
      window as unknown as { releaseNativeStart: () => void }
    ).releaseNativeStart(),
  );
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { activeNativeUser?: string }).activeNativeUser,
    ),
  ).toBe(currentUser);
});
test("permission controls distinguish confirmed GPS and enabled notification permission", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  // Headless Chromium's Notification getter can remain denied while its
  // Permissions API reports granted. Control this browser boundary only.
  await page.addInitScript(() => {
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      value: "default",
    });
  });
  try {
    await login(page, "driver");
    const gps = page.getByRole("button", { name: "Включить GPS", exact: true });
    const alerts = page.getByRole("button", {
      name: "Включить уведомления и звук",
      exact: true,
    });
    await expect(gps).toHaveAttribute("data-state", /inactive|blocked/);
    await expect(alerts).toHaveAttribute("data-state", "inactive");
    let releaseReport!: () => void;
    const reportGate = new Promise<void>((resolve) => {
      releaseReport = resolve;
    });
    await page.route("**/driver/location", async (route) => {
      await reportGate;
      await route.continue();
    });
    const gpsStarted = startGps(page);
    await expect(gps).toHaveAttribute("data-state", "pending");
    await expect(
      page.getByRole("button", { name: "Выйти на линию", exact: true }),
    ).toBeDisabled();
    releaseReport();
    await gpsStarted;
    await expect(gps).toHaveAttribute("data-state", "ready");
    await page
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    const power = page.getByRole("button", {
      name: "Уйти с линии",
      exact: true,
    });
    await expect(power).toHaveAttribute(
      "aria-description",
      /Связь с диспетчером установлена/,
    );
    await context.setOffline(true);
    await expect(power).toHaveAttribute(
      "aria-description",
      /Нет связи с диспетчером/,
    );
    await context.setOffline(false);
    await expect(power).toHaveAttribute(
      "aria-description",
      /Связь с диспетчером установлена/,
    );
    await power.click();
    await page.evaluate(() => {
      Object.defineProperty(Notification, "permission", { value: "granted" });
      window.dispatchEvent(new Event("focus"));
    });
    await expect(alerts).toHaveAttribute(
      "aria-description",
      /Уведомления разрешены/,
    );
    // Permission alone does not prove audio has been unlocked by a gesture.
    await expect(alerts).not.toHaveAttribute("data-state", "ready");
    await alerts.click();
    await expect(alerts).toHaveAttribute("data-state", "ready");
    await page.evaluate(() => {
      Object.defineProperty(Notification, "permission", { value: "denied" });
      window.dispatchEvent(new Event("focus"));
    });
    await expect(alerts).toHaveAttribute("data-state", "blocked");
    await expect(alerts).toHaveAttribute("aria-description", /заблокированы/);
  } finally {
    await context.close();
  }
});

for (const [savedAdminSession, driverEntry] of [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const) {
  test(`driver reload never renders dispatcher navigation with ${savedAdminSession ? "both sessions saved" : "only a driver session"} via ${driverEntry ? "driver bundle" : "web bundle"}`, async ({
    page,
  }) => {
    if (savedAdminSession) await login(page, "admin");
    await login(page, "driver");
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restoring = new Promise<void>((resolve) => {
      reached = resolve;
    });
    await page.route("**/api/driver/profile", async (route) => {
      reached();
      await gate;
      await route.continue();
    });
    try {
      if (driverEntry)
        await page.goto("/driver.html", { waitUntil: "domcontentloaded" });
      else await page.reload({ waitUntil: "domcontentloaded" });
      await restoring;
      await expect(
        page.getByRole("navigation", { name: "Разделы диспетчера" }),
      ).toHaveCount(0);
      release();
      await expect(
        page.getByRole("button", { name: "Включить GPS", exact: true }),
      ).toBeVisible();
      await expect(page).toHaveURL(/driverDashboard/);
      await expect(
        page.getByRole("navigation", { name: "Разделы диспетчера" }),
      ).toHaveCount(0);
    } finally {
      release();
      await page.unroute("**/api/driver/profile");
    }
  });
}

test("auth throttling blocks repeated attempts from one browser without blocking another", async ({
  browser,
}) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    await isolateBrowserClient(await first.newPage());
    await isolateBrowserClient(await second.newPage());
    const invalidLogin = {
      data: { phone: "+99360000000", password: "wrong-password" },
    };
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await first.request.post(
        "/api/auth/login",
        invalidLogin,
      );
      expect(response.status()).toBe(401);
    }
    const blocked = await first.request.post("/api/auth/login", invalidLogin);
    expect(blocked.status()).toBe(429);
    const otherClient = await second.request.post(
      "/api/auth/login",
      invalidLogin,
    );
    expect(otherClient.status()).toBe(401);
  } finally {
    await first.close();
    await second.close();
  }
});

test("driver feedback shows blockers until recovery and action errors without an extra tap", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "driver");
  await expect(
    page.getByText("Включите GPS, чтобы принимать заказы.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Показать сообщение", exact: true }),
  ).toHaveCount(0);
  await startGps(page);
  await expect(
    page.getByText("Включите GPS, чтобы принимать заказы.", { exact: true }),
  ).toHaveCount(0);
  const failure = "Не удалось выйти на линию. Повторите попытку.";
  const failNextStatus = () =>
    page.route(
      "**/api/driver/status",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ message: failure }),
        }),
      { times: 1 },
    );
  await failNextStatus();
  await page.clock.install();
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  const toast = page.getByRole("listitem", {
    name: "Сообщение водителю",
    exact: true,
  });
  await expect(toast).toContainText(failure);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // A background refresh must not cut short the error's reading time.
  const refreshing = page.waitForResponse("**/api/driver/profile");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await (await refreshing).finished();
  await expect(toast).toContainText(failure);
  await page.clock.fastForward(9000);
  await expect(toast).toHaveCount(0);
  // Repeating the same failure during a background refresh must not reopen it.
  await page.route(
    "**/api/driver/profile",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ message: failure }),
      }),
    { times: 1 },
  );
  const backgroundFailure = page.waitForResponse("**/api/driver/profile");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await (await backgroundFailure).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(toast).toHaveCount(0);
  // A deliberate retry must be allowed to show the same failure again.
  await failNextStatus();
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  await expect(toast).toContainText(failure);
  await page.keyboard.press("F8");
  await page.keyboard.press("Escape");
  await expect(toast).toHaveCount(0);
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Уйти с линии", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(toast).toHaveCount(0);
});

test("driver labels feel native while the chat composer remains editable", async ({
  page,
}) => {
  await login(page, "driver");
  const region = page
    .getByRole("group", { name: "Регионы", exact: true })
    .getByRole("button")
    .first();
  await expect(region).toHaveCSS("user-select", "none");
  await page.goto("/driverChat");
  const composer = page.getByRole("textbox");
  await composer.fill("Исправить сообщение");
  await expect(composer).toHaveCSS("user-select", "text");
  await composer.selectText();
  await page.keyboard.type("Новое сообщение");
  await expect(composer).toHaveValue("Новое сообщение");
  await page.goto("/adminLogin");
  await expect(page.locator("html")).not.toHaveClass(/driver-app/);
});

test("GPS outside every saved region keeps its actual coordinates and ignores a stale Yandex address", async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Only the external geocoder boundary is simulated. GPS reports and
    // dispatch-region matching still use the real API and disposable database.
    const pending: Array<(value: unknown) => void> = [];
    (window as any).addressReplies = pending;
    (window as any).ymaps = {
      ready: (callback: () => void) => callback(),
      geocode: () => new Promise((resolve) => pending.push(resolve)),
    };
  });
  await login(page, "driver");
  await startGps(page);
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "ТЕСТ — Центральный",
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).addressReplies.length))
    .toBe(1);
  await page.evaluate(() =>
    (window as any).addressReplies.shift()({
      geoObjects: {
        get: () => ({
          getThoroughfare: () => "Гёроглы",
          getPremiseNumber: () => "10",
          getAddressLine: () => "Ашхабад, Гёроглы, 10",
        }),
      },
    }),
  );
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "Гёроглы, 10",
  );
  // A reload starts a fresh lookup; a late answer must not overwrite a newer GPS fix.
  await page.reload();
  await startGps(page);
  await expect
    .poll(() => page.evaluate(() => (window as any).addressReplies.length))
    .toBe(1);
  await page
    .context()
    .setGeolocation({ latitude: 30.2328, longitude: 120.0398, accuracy: 10 });
  const location = page.getByLabel("Местоположение GPS");
  await expect(location).toContainText("30.2328, 120.0398");
  await page.evaluate(() =>
    (window as any).addressReplies.shift()({
      geoObjects: {
        get: () => ({
          getThoroughfare: () => "Устаревший адрес",
          getPremiseNumber: () => "1",
        }),
      },
    }),
  );
  await expect(location).not.toContainText("Устаревший адрес");
  await expect(location).toContainText("30.2328, 120.0398");
  await page.waitForTimeout(10_100); // Production GPS report rate limit.
  const report = page.waitForResponse(
    (response) =>
      response.url().endsWith("/driver/location") &&
      response.request().method() === "POST",
  );
  await page
    .context()
    .setGeolocation({ latitude: 30.2329, longitude: 120.0399, accuracy: 10 });
  expect((await report).ok()).toBe(true);
  await expect(location).toContainText("Вне районов");
  await expect(location).toContainText("30.2329, 120.0399");
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeEnabled();
});

test("a rejected Yandex lookup leaves GPS readiness and actual coordinates usable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).ymaps = {
      ready: (callback: () => void) => callback(),
      geocode: () => Promise.reject(new Error("Invalid api key")),
    };
  });
  await login(page, "driver");
  await startGps(page);
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "37.9600, 58.3200",
  );
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toHaveAttribute("data-state", "ready");
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeEnabled();
});

test("dispatcher overview uses global counts and labels completed trip values as all-time", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const overview = page.waitForResponse((response) =>
    response.url().endsWith("/admin/overview"),
  );
  await login(page, "admin");
  expect((await overview).ok()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Обзор", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Завершённые поездки за всё время",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Средняя известная стоимость", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/последние 100|Сумма последних/)).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
