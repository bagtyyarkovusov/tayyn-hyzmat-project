import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { createRequire } from "node:module";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");
const password = process.env.TEST_ACCOUNT_PASSWORD!;
const require = createRequire(
  new URL("../../backend/package.json", import.meta.url),
);
const { PrismaClient } = require("@prisma/client");
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
async function startGps(
  page: Page,
  point = { latitude: 37.96, longitude: 58.32, accuracy: 10 },
) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation(point);
  const gps = page.getByRole("button", { name: "Включить GPS", exact: true });
  await gps.click();
  await expect(gps).toHaveAttribute("data-state", "ready");
}
async function expectLocalGpsFix(page: Page) {
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toHaveAttribute("data-state", "ready");
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "37.9600, 58.3200",
  );
}
for (const role of ["driver", "admin"] as const) {
  test(`${role} mobile login shows the form immediately and keeps it reachable in a short viewport`, async ({
    page,
  }) => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 568 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(role === "admin" ? "/adminLogin" : "/driverLogin");
      await expect(
        page.getByRole("link", { name: "Tayyn Hyzmat" }),
      ).toBeVisible();
      const phone = page.getByLabel("Номер телефона", { exact: true });
      const phoneBox = await phone.boundingBox();
      expect(phoneBox!.y).toBeLessThan(250);
      await expect(
        page.getByRole("button", { name: "Войти", exact: true }),
      ).toBeInViewport();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(viewport.width);
    }
    // A resized viewport checks reachability; real Android IME evidence is separate.
    await page.setViewportSize({ width: 320, height: 300 });
    await page.getByLabel("Пароль", { exact: true }).focus();
    await expect(page.getByLabel("Пароль", { exact: true })).toBeInViewport();
    const submit = page.getByRole("button", { name: "Войти", exact: true });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(320);
  });
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
    await driver.clock.install();
    await login(dispatcher, "admin");
    await login(driver, "driver");
    await startGps(driver);
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      driver.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
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
      driver
        .getByRole("dialog", { name: "Управление поездкой", exact: true })
        .locator('a[href="tel:+99360000999"]'),
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
      driver
        .getByRole("dialog", { name: "Управление поездкой", exact: true })
        .locator('a[href="tel:+99360000999"]'),
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
    let releaseLongMessage!: () => void;
    const longMessageResponse = new Promise<void>((resolve) => {
      releaseLongMessage = resolve;
    });
    await dispatcher.route("**/api/admin/messages", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch();
      await longMessageResponse;
      await route.fulfill({ response });
    });
    const sendingHistory = dispatcher.getByRole("region", {
      name: "Переписка",
    });
    try {
      await dispatcher.getByLabel("Сообщение водителю").fill(longMessage);
      await dispatcher.getByLabel("Сообщение водителю").press("Enter");
      await expect(
        driver.getByText(longMessage.trim(), { exact: true }),
      ).toBeVisible();
      await expect(
        dispatcher.getByText(longMessage.trim(), { exact: true }),
      ).toBeVisible();
      // Socket delivery may beat the sender's HTTP response. Reading earlier
      // history while that response is pending must win over its auto-scroll.
      await sendingHistory.evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event("scroll"));
      });
    } finally {
      releaseLongMessage();
    }
    await expect(dispatcher.getByLabel("Сообщение водителю")).toHaveJSProperty(
      "readOnly",
      false,
    );
    await expect(dispatcher.getByLabel("Сообщение водителю")).toHaveValue("");
    await expect
      .poll(() => sendingHistory.evaluate((el) => el.scrollTop))
      .toBeLessThan(10);
    await dispatcher.unroute("**/api/admin/messages");
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
        data: {
          operationId: crypto.randomUUID(),
          amount: 1,
          type: "TOPUP",
          note: `Проверка страниц ${i}`,
        },
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
  await page.getByRole("link", { name: "Профиль", exact: true }).click();
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
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await expectLocalGpsFix(page);
    await page
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
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
    let driverId = "";
    await expect
      .poll(async () => {
        const response = await context.request.get(
          `${process.env.TEST_API_URL}/driver/profile`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        const profile = await response.json();
        driverId = profile.id;
        return Number(profile.lastLat);
      })
      .toBe(37.9701);
    await page.getByRole("link", { name: "Профиль", exact: true }).click();
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
    expect(response.status()).toBe(401);
    const dispatcher = await context.request.post(
      `${process.env.TEST_API_URL}/auth/login`,
      {
        data: { phone: "+99360000000", password },
      },
    );
    expect(dispatcher.ok()).toBe(true);
    const persisted = await context.request.get(
      `${process.env.TEST_API_URL}/admin/drivers/${driverId}`,
      {
        headers: {
          Authorization: `Bearer ${(await dispatcher.json()).accessToken}`,
        },
      },
    );
    expect(Number((await persisted.json()).lastLat)).toBe(37.9701);
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
    await expectLocalGpsFix(page);
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
    await expectLocalGpsFix(page);
    // Navigate through browser history without reloading the application singleton.
    await page.evaluate(() => {
      history.pushState({}, "", "/driverLogin");
      dispatchEvent(new PopStateEvent("popstate"));
    });
    await page.getByLabel("Номер телефона").fill("+99360000102");
    await page.getByLabel("Пароль", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(/driverDashboard/);
    await expect(
      page.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toHaveAttribute("data-state", /inactive|blocked/);
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
      driver
        .getByRole("dialog", { name: "Управление поездкой", exact: true })
        .locator('a[href="tel:+99360000888"]'),
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
      driver
        .getByRole("dialog", { name: "Управление поездкой", exact: true })
        .locator('a[href="tel:+99360000888"]'),
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
  await expectLocalGpsFix(page);
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
  const prisma = new PrismaClient();
  // This test needs exact counts. Other workflows deliberately leave live
  // drivers/orders in the default region, so use our own disposable polygon.
  const region = await prisma.district.create({
    data: {
      name: "ТЕСТ — Очередь восстановления",
      centerLat: 22,
      centerLng: 22,
      boundary: [
        [
          [21.9, 21.9],
          [21.9, 22.1],
          [22.1, 22.1],
          [22.1, 21.9],
          [21.9, 21.9],
        ],
      ],
    },
  });
  const point = { latitude: 22, longitude: 22, accuracy: 10 };
  const a = await browser.newContext();
  const b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const dispatcher = await a.newPage();
  const driver = await b.newPage();
  try {
    await login(dispatcher, "admin");
    await login(driver, "driver", "+99360000103");
    await test.step("acquire local GPS before opening the shift", () =>
      startGps(driver, point));
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
      // This recovery test uses the driver's initial regional window.
      // Cross-region deadline/claim behavior has dedicated API/socket coverage.
      (r: { id: string }) => r.id === region.id,
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
      driver
        .getByRole("dialog", { name: "Управление поездкой", exact: true })
        .locator('a[href="tel:+99360000777"]'),
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
    await test.step("refresh GPS without losing readiness after completing the recovered trip", () =>
      startGps(driver, point));
    await expect(
      driver.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await test.step("an older HTTP snapshot cannot replace newer live counts", async () => {
      let release = () => {};
      try {
        await expect(card.getByText("0:1", { exact: true })).toBeVisible();
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
        // The driver's own-region order opens the normal incoming-offer modal.
        // Dismiss it so the background region card is observable for the
        // stale-HTTP-snapshot assertion below.
        const incoming = driver.getByRole("dialog", {
          name: "Предложение заказа",
          exact: true,
        });
        await expect(incoming).toBeVisible();
        await incoming
          .getByRole("button", { name: "Скрыть предложение", exact: true })
          .click();
        await expect(card.getByText("1:1", { exact: true })).toBeVisible();
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
        await expect(card.getByText("1:1", { exact: true })).toBeVisible();
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
        await expect(card.getByText("0:1", { exact: true })).toBeVisible();
      } finally {
        release();
      }
    });
  } finally {
    await a.close();
    await b.close();
    try {
      // Fixture cleanup only. No behavior assertions bypass the public API.
      await prisma.transaction.deleteMany({
        where: { order: { districtId: region.id } },
      });
      await prisma.order.deleteMany({ where: { districtId: region.id } });
      await prisma.driver.updateMany({
        where: { districtId: region.id },
        data: { districtId: null, isOnline: false, shiftDeviceId: null },
      });
      await prisma.district.delete({ where: { id: region.id } });
    } finally {
      await prisma.$disconnect();
    }
  }
});

test("a delayed one-shot timeout cannot erase a newer successful GPS watch fix", async ({
  page,
}) => {
  await page.addInitScript(() => {
    let requests = 0;
    let staleFailure: PositionErrorCallback | null | undefined;
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
        getCurrentPosition(
          success: PositionCallback,
          failure?: PositionErrorCallback,
        ) {
          if (++requests === 1) setTimeout(() => success(position()), 0);
          else staleFailure = failure;
        },
        watchPosition(success: PositionCallback) {
          setTimeout(() => success(position()), 0);
          return 1;
        },
        clearWatch() {},
      },
    });
    window.addEventListener("late-one-shot-timeout", () =>
      staleFailure?.({
        code: 3,
        message: "Old request timeout",
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
      }),
    );
  });
  await login(page, "driver");
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  const online = page.getByRole("button", {
    name: "Уйти с линии",
    exact: true,
  });
  await expect(online).toBeVisible();
  await page.waitForTimeout(100);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("late-one-shot-timeout")),
  );
  await expect(online).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toHaveAttribute("data-state", "ready");
});

test("a transient GPS timeout keeps its blocker visible until an explicit retry receives a fresh local fix", async ({
  page,
}) => {
  // A separate synthetic client exercises recovery without exhausting the login limiter used by earlier workflows.
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "127.0.0.79" });
  await page.context().grantPermissions(["geolocation"]);
  await page.addInitScript(() => {
    let watch: PositionCallback | undefined;
    let pendingPosition: PositionCallback | undefined;
    let holdPosition = false;
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
          if (holdPosition) pendingPosition = success;
          else queueMicrotask(() => success(position()));
        },
      },
    });
    window.addEventListener("synthetic-gps-hold", () => {
      holdPosition = true;
    });
    window.addEventListener("synthetic-gps-release", () => {
      holdPosition = false;
      pendingPosition?.(position());
      pendingPosition = undefined;
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
    window.addEventListener("synthetic-gps-watch-probe", () => {
      window.dispatchEvent(
        new CustomEvent("synthetic-gps-watch-ready", { detail: !!failure }),
      );
    });
  });
  await login(page, "driver");
  const token = await page.evaluate(() =>
    localStorage.getItem("openride.driver.accessToken"),
  );
  expect(
    (
      await page.request.post(`${process.env.TEST_API_URL}/driver/status`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { isOnline: false },
      })
    ).ok(),
  ).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  const power = page.getByRole("button", {
    name: "Выйти на линию",
    exact: true,
  });
  await expect(power).toBeEnabled();
  await power.click();
  await expect(
    page.getByRole("button", { name: "Уйти с линии", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        let ready = false;
        window.addEventListener(
          "synthetic-gps-watch-ready",
          (event) => {
            ready = (event as CustomEvent<boolean>).detail;
          },
          { once: true },
        );
        window.dispatchEvent(new Event("synthetic-gps-watch-probe"));
        return ready;
      }),
    )
    .toBe(true);
  // A profile fetched before GPS fails may arrive after Offline. It must
  // not restart location tracking or clear the explicit-retry blocker.
  let releaseProfile!: () => void;
  const profileHeld = new Promise<void>((resolve) => {
    releaseProfile = resolve;
  });
  let profileCaptured!: () => void;
  const captured = new Promise<void>((resolve) => {
    profileCaptured = resolve;
  });
  await page.route("**/api/driver/profile", async (route) => {
    const response = await route.fetch();
    profileCaptured();
    await profileHeld;
    await route.fulfill({ response });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await captured;
  await page.evaluate(() =>
    window.dispatchEvent(new Event("synthetic-gps-timeout")),
  );
  releaseProfile();
  await expect(power).toBeDisabled();
  await expect(
    page.getByText(/GPS.*(?:временно недоступен|не ответил)/).first(),
  ).toBeAttached();
  await expect(
    page
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button")
      .first(),
  ).toBeDisabled();
  expect(
    (
      await page.request.get(`${process.env.TEST_API_URL}/orders/available`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status(),
  ).toBe(403);
  await page.evaluate(() =>
    window.dispatchEvent(new Event("synthetic-gps-hold")),
  );
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(
    page.getByText(/GPS.*(?:временно недоступен|не ответил)/).first(),
  ).toBeAttached();
  await expect(power).toBeDisabled();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("synthetic-gps-release")),
  );
  await expect(power).toBeEnabled({ timeout: 5000 });
  await expectLocalGpsFix(page);
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
      syntheticNativePermissionDenied?: boolean;
      syntheticNativeGpsDisabled?: boolean;
      holdNextNativeStatus?: boolean;
      nativeStatusHeld?: boolean;
      releaseNativeStatus?: () => void;
      nativeFixAt?: number;
      syntheticConnectionStatus?: Record<string, unknown>;
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
          name: "DriverUi",
          methods: [
            "ready",
            "respondBack",
            "resetBack",
            "detach",
            "theme",
            "removeListener",
          ]
            .map((name) => ({ name, rtype: "promise" }))
            .concat([{ name: "addListener", rtype: "callback" }]),
        },
        {
          name: "DriverNotifications",
          methods: [
            ...[
              "status",
              "requestPermissions",
              "configure",
              "reconcileOrders",
              "setPresence",
              "deliver",
              "clear",
              "reset",
              "settings",
              "removeListener",
            ].map((name) => ({ name, rtype: "promise" })),
            { name: "addListener", rtype: "callback" },
          ],
        },
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
      nativeCallback: () => "synthetic-notification-listener",
      nativePromise: async (
        plugin: string,
        method: string,
        options?: { shiftToken?: string; userId?: string },
      ) => {
        if (plugin === "DriverNotifications")
          return method === "status" || method === "requestPermissions"
            ? { permission: "denied", enabled: false, configured: false }
            : {};
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
            locationGranted: !bridge.syntheticNativePermissionDenied,
            locationEnabled: !bridge.syntheticNativeGpsDisabled,
            ordersEnabled: true,
            chatEnabled: true,
          };
        }
        if (method === "permissions")
          return new Promise((resolve) => {
            bridge.releaseNativePermission = () =>
              resolve({
                locationGranted: true,
                locationEnabled: true,
                ordersEnabled: true,
                chatEnabled: true,
              });
          });
        if (method === "location") {
          bridge.nativeFixAt = Date.now();
          return {
            lat: 37.96,
            lng: 58.32,
            accuracy: 10,
            timestamp: bridge.nativeFixAt,
          };
        }
        if (method === "status") {
          const snapshot = {
            ...status,
            locationGranted: !bridge.syntheticNativePermissionDenied,
            locationEnabled: !bridge.syntheticNativeGpsDisabled,
            lastFixAt: bridge.nativeFixAt ?? 0,
            lat: 37.96,
            lng: 58.32,
            accuracy: 10,
            ...bridge.syntheticConnectionStatus,
            ...(bridge.syntheticNativeStopped
              ? {
                  detail: "Смена завершена сервером",
                  stopSequence: bridge.syntheticNativeStopSequence ?? 1,
                }
              : {}),
          };
          if (bridge.holdNextNativeStatus) {
            bridge.holdNextNativeStatus = false;
            bridge.nativeStatusHeld = true;
            return new Promise((resolve) => {
              bridge.releaseNativeStatus = () => resolve(snapshot);
            });
          }
          return snapshot;
        }
        return {};
      },
    };
  }, holdPermission);
}

test("native foreground detects revoked GPS permission while the shift is off", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await emulateNativeBridge(page, false);
  await login(page, "driver");
  const gps = page.getByRole("button", { name: "Включить GPS", exact: true });
  await gps.click();
  await expect(gps).toHaveAttribute("data-state", "ready");
  await page.evaluate(() => {
    (
      window as unknown as { syntheticNativePermissionDenied: boolean }
    ).syntheticNativePermissionDenied = true;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(gps).toHaveAttribute("data-state", "blocked");
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeDisabled();
  expect(pageErrors).toEqual([]);
});

type NativeGpsRaceBridge = {
  holdNextNativeStatus: boolean;
  nativeStatusHeld: boolean;
  syntheticNativePermissionDenied: boolean;
  releaseNativeStatus: () => void;
};

test("a native status captured before permission revocation cannot restore the invalidated GPS fix", async ({
  page,
}) => {
  await emulateNativeBridge(page, false);
  await login(page, "driver");
  const gps = page.getByRole("button", { name: "Включить GPS", exact: true });
  await gps.click();
  await expect(gps).toHaveAttribute("data-state", "ready");
  await page.evaluate(() => {
    (window as unknown as NativeGpsRaceBridge).holdNextNativeStatus = true;
  });
  // The periodic native status read captures the old granted permission/fix.
  await expect
    .poll(() =>
      page.evaluate(
        () => !!(window as unknown as NativeGpsRaceBridge).nativeStatusHeld,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    (window as unknown as NativeGpsRaceBridge).syntheticNativePermissionDenied =
      true;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(gps).toHaveAttribute("data-state", "blocked");
  await page.evaluate(async () => {
    (window as unknown as NativeGpsRaceBridge).releaseNativeStatus();
    // Flush the bridge completion and Vue rendering before checking its effect.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect(gps).toHaveAttribute("data-state", "blocked");
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => {
    (window as unknown as NativeGpsRaceBridge).syntheticNativePermissionDenied =
      false;
    window.dispatchEvent(new Event("focus"));
  });
  await expect(gps).toHaveAttribute("data-state", "blocked");
  await gps.click();
  await expect(gps).toHaveAttribute("data-state", "ready");
});

for (const foreground of [true, false]) {
  test(`native GPS system switch is checked ${foreground ? "on foreground" : "before going online"} independently of permission`, async ({
    page,
  }) => {
    await emulateNativeBridge(page, false);
    await login(page, "driver");
    const gps = page.getByRole("button", { name: "Включить GPS", exact: true });
    await gps.click();
    await expect(gps).toHaveAttribute("data-state", "ready");
    await page.evaluate((foreground) => {
      (
        window as unknown as { syntheticNativeGpsDisabled: boolean }
      ).syntheticNativeGpsDisabled = true;
      if (foreground) window.dispatchEvent(new Event("focus"));
    }, foreground);
    const power = page.getByRole("button", {
      name: "Выйти на линию",
      exact: true,
    });
    if (!foreground) await power.click();
    await expect(gps).toHaveAttribute("data-state", "blocked");
    await expect(power).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveCount(0);
  });
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

test("native connection recovery turns red at the actual lease deadline and requires Online again", async ({
  page,
}) => {
  await emulateNativeBridge(page, false);
  await createAddressDriver(page, "+99360000344");
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Уйти с линии", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { activeNativeUser?: string }).activeNativeUser,
      ),
    )
    .toBeTruthy();
  await page.evaluate(() => {
    const bridge = window as unknown as {
      activeNativeUser: string;
      syntheticConnectionStatus: Record<string, unknown>;
    };
    bridge.syntheticConnectionStatus = {
      running: true,
      userId: bridge.activeNativeUser,
      phase: "reconnecting",
      leaseRemainingMs: 20_000,
      lastFixAt: Date.now(),
      lastReportAt: Date.now() - 5000,
    };
    window.dispatchEvent(new Event("focus"));
  });
  const connection = page.getByRole("button", {
    name: "Связь с диспетчером",
    exact: true,
  });
  await expect(connection).toHaveAttribute("data-state", "reconnecting");
  await page.evaluate(() => {
    const bridge = window as unknown as {
      syntheticConnectionStatus: Record<string, unknown>;
    };
    bridge.syntheticConnectionStatus.leaseRemainingMs = 0;
    window.dispatchEvent(new Event("focus"));
  });
  // An online account snapshot must not extend a native service's expired lease.
  await expect(connection).toHaveAttribute("data-state", "disconnected");
  await page.evaluate(() => {
    const bridge = window as unknown as {
      syntheticConnectionStatus: Record<string, unknown>;
    };
    bridge.syntheticConnectionStatus = {
      running: false,
      phase: "off",
      detail: "Связь потеряна. Включите линию снова.",
      stopSequence: 1,
      lastFixAt: Date.now(),
      leaseRemainingMs: 0,
    };
    window.dispatchEvent(new Event("focus"));
  });
  const online = page.getByRole("button", {
    name: "Выйти на линию",
    exact: true,
  });
  await expect(online).toHaveAttribute("aria-pressed", "false");
  await expect(online).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toHaveAttribute("data-state", "ready");
  await expect(connection).toHaveAttribute("data-state", "ready");
  await expect(
    page.getByText(
      "Смена завершена. После восстановления связи нажмите кнопку выхода на линию.",
      { exact: true },
    ),
  ).toBeVisible();
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
  ).toBeEnabled();
  await expect(
    page.getByText("Смена завершена сервером", { exact: true }),
  ).toHaveCount(0);
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
  await createAddressDriver(page, "+99360000341");
  await createAddressDriver(page, "+99360000331");
  await emulateNativeBridge(page, true);
  await login(page, "driver", "+99360000341");
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
  await page.getByLabel("Номер телефона").fill("+99360000331");
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
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toHaveAttribute("data-state", /inactive|blocked/);
});

test("a cancelled native Online operation cannot offline a newly signed-in driver", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": "127.0.0.81" });
  await createAddressDriver(page, "+99360000342");
  await createAddressDriver(page, "+99360000332");
  await emulateNativeBridge(page, false);
  await login(page, "driver", "+99360000342");
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expectLocalGpsFix(page);
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
  await page.getByLabel("Номер телефона").fill("+99360000332");
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
  await createAddressDriver(page, "+99360000343");
  await createAddressDriver(page, "+99360000333");
  await emulateNativeBridge(page, false);
  await login(page, "driver", "+99360000343");
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expectLocalGpsFix(page);
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
  await page.getByLabel("Номер телефона").fill("+99360000333");
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/driverDashboard/);
  await page.evaluate(() => {
    (window as unknown as { holdNativeStart: boolean }).holdNativeStart = false;
  });
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expectLocalGpsFix(page);
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
test("GPS remains green during connection loss and reconnects without another permission request", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  try {
    await login(page, "driver");
    const gps = page.getByRole("button", { name: "Включить GPS", exact: true });
    const connection = page.getByRole("button", {
      name: "Связь с диспетчером",
      exact: true,
    });
    await expect(connection).toHaveAttribute("data-state", "ready");
    await connection.click();
    await expect(page.getByRole("menu")).toContainText(
      "Связь с диспетчером установлена",
    );
    await page.keyboard.press("Escape");
    await expect(page.locator(".workspace-header .connection")).toHaveCount(0);
    await expect(gps).toHaveAttribute("data-state", /inactive|blocked/);
    await startGps(page);
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
    await expect(connection).toHaveAttribute("data-state", "reconnecting");
    await expect(connection).toHaveAttribute("aria-description", /60 секунд/);
    await expect(power).toHaveAttribute(
      "aria-description",
      /Нет связи с диспетчером/,
    );
    await expect(gps).toHaveAttribute("data-state", "ready");
    await expect(
      page.getByText("Нет интернета. Пытаемся подключиться…", { exact: true }),
    ).toBeVisible();
    await context.setOffline(false);
    await expect(connection).toHaveAttribute("data-state", "ready");
    await expect(power).toHaveAttribute(
      "aria-description",
      /Связь с диспетчером установлена/,
    );
    await expect(
      page.getByText("Нет интернета. Пытаемся подключиться…", { exact: true }),
    ).toHaveCount(0);
    await power.click();
    await expect(
      page.getByRole("button", { name: "Выйти на линию", exact: true }),
    ).toBeVisible();
    await context.setOffline(true);
    await expect(connection).toHaveAttribute("data-state", "disconnected");
    await expect(connection).toHaveAttribute(
      "aria-description",
      /Нет интернета/,
    );
    await expect(gps).toHaveAttribute("data-state", "ready");
  } finally {
    await context.close();
  }
});

test("offline drivers keep a local GPS fix, show its timestamp, and send no location uploads", async ({
  page,
}) => {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({
    latitude: 37.96,
    longitude: 58.32,
    accuracy: 10,
  });
  await login(page, "driver");
  await page.context().setOffline(true);
  let uploads = 0;
  await page.route("**/driver/location", async (route) => {
    uploads++;
    await route.abort();
  });
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  const gps = page.getByRole("button", { name: "Включить GPS", exact: true });
  await expect(gps).toHaveAttribute("data-state", "ready");
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "37.9600, 58.3200",
  );
  await expect(page.getByText(/Последнее обновление/)).toBeVisible();
  expect(uploads).toBe(0);
  await page.context().setOffline(false);
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

async function createAddressDriver(page: Page, phone: string) {
  await login(page, "admin");
  const token = await page.evaluate(() =>
    localStorage.getItem("openride.admin.accessToken"),
  );
  const create = await page.request.post(
    `${process.env.TEST_API_URL}/admin/drivers`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: { fullName: "Synthetic address driver", phone, password },
    },
  );
  expect(create.ok()).toBe(true);
  const driver = await create.json();
  const topup = await page.request.post(
    `${process.env.TEST_API_URL}/admin/drivers/${driver.id}/balance`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        operationId: crypto.randomUUID(),
        amount: 500,
        type: "TOPUP",
        note: "Synthetic address fixture",
      },
    },
  );
  expect(topup.ok()).toBe(true);
  await login(page, "driver", phone);
  return driver;
}
test("a delayed address cannot replace a newer GPS position outside the saved region", async ({
  page,
}) => {
  await createAddressDriver(page, "+99360000321");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let originalAddress = "";
  await page.route("**/geo/drivers/*/address", async (route) => {
    const response = await route.fetch();
    originalAddress = (await response.json()).address || "";
    await gate;
    await route.fulfill({ response }); // Delay actual API bytes, never invent an internal response.
  });
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({
    latitude: 37.961234,
    longitude: 58.321234,
    accuracy: 10,
  });
  const lookup = page.waitForRequest((request) =>
    /\/geo\/drivers\/[^/]+\/address/.test(request.url()),
  );
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  await lookup;
  await expect.poll(() => originalAddress).toBe("Synthetic street, 12");
  await expect(
    page.getByRole("button", { name: "Уйти с линии", exact: true }),
  ).toBeVisible();
  // Starting the shift requests another fix; let that acknowledgement's
  // real ten-second upload throttle expire before delivering movement.
  await page.waitForTimeout(10_100);
  await page
    .context()
    .setGeolocation({ latitude: 30.2328, longitude: 120.0398, accuracy: 10 });
  const location = page.getByLabel("Местоположение GPS");
  await expect(location).toContainText("30.2328, 120.0398");
  await expect(location).toContainText("Вне районов");
  release();
  await page.waitForTimeout(250);
  await expect(location).not.toContainText("Synthetic street");
  await expect(location).toContainText("30.2328, 120.0398");
  await page.unrouteAll({ behavior: "wait" });
});

test("a delayed address survives a nearby driver GPS fix during its request", async ({
  page,
}) => {
  await createAddressDriver(page, "+99360000325");
  await startGps(page, {
    latitude: 37.961234,
    longitude: 58.321234,
    accuracy: 10,
  });
  // Consume the off-shift convenience allowance first. Relaunch with its
  // durable marker, then exercise a delayed Online lookup without an earlier
  // still-fresh label hiding the coordinate fallback under test.
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "Synthetic street, 12",
  );
  await page.reload();
  await startGps(page, {
    latitude: 37.961234,
    longitude: 58.321234,
    accuracy: 10,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received = false;
  await page.route("**/geo/drivers/*/address", async (route) => {
    const response = await route.fetch();
    received = (await response.json()).address === "Synthetic street, 12";
    await gate;
    await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  await expect.poll(() => received).toBe(true);
  const refresh = page.getByRole("button", {
    name: "Обновить адрес",
    exact: true,
  });
  await expect(refresh).toBeDisabled();
  await page
    .context()
    .setGeolocation({ latitude: 37.9613, longitude: 58.3213, accuracy: 10 });
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "37.9613, 58.3213",
  );
  release();
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "Synthetic street, 12",
  );
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute(
    "title",
    "Обновить адрес можно раз в пять минут",
  );
  await page.unrouteAll({ behavior: "wait" });
});

test("an unavailable server Geocoder leaves GPS readiness and actual coordinates usable", async ({
  page,
}) => {
  await createAddressDriver(page, "+99360000322");
  const lookup = page.waitForResponse((response) =>
    /\/geo\/drivers\/[^/]+\/address/.test(response.url()),
  );
  await startGps(page);
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  expect((await lookup).ok()).toBe(true);
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "37.9600, 58.3200",
  );
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toHaveAttribute("data-state", "ready");
  await expect(
    page.getByRole("button", { name: "Уйти с линии", exact: true }),
  ).toBeEnabled();
});

test("hidden Online catches up once when the driver returns to the foreground", async ({
  page,
}) => {
  await createAddressDriver(page, "+99360000323");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/geo\/drivers\/[^/]+\/address/.test(request.url()))
      requests.push(request.url());
  });
  await startGps(page);
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Уйти с линии", exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(350);
  await expect.poll(() => requests.length).toBe(1);
  await expect(
    page.getByRole("button", { name: "Обновить адрес", exact: true }),
  ).toBeDisabled();
});

test("one off-shift convenience lookup survives relaunch and Online refreshes it once", async ({
  page,
}) => {
  const created = await createAddressDriver(page, "+99360000326");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/geo\/drivers\/[^/]+\/address/.test(request.url()))
      requests.push(request.postDataJSON().purpose);
  });
  await startGps(page, {
    latitude: 37.961234,
    longitude: 58.321234,
    accuracy: 10,
  });
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "Synthetic street, 12",
  );
  await page.reload();
  await startGps(page, {
    latitude: 37.961234,
    longitude: 58.321234,
    accuracy: 10,
  });
  expect(requests).toHaveLength(1);
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  await expect.poll(() => requests).toEqual(["off-shift", "online"]);
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "Synthetic street, 12",
  );
  // Opening another app must not erase a still-fresh address or spend quota
  // when the driver returns to the same location.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByLabel("Местоположение GPS")).not.toContainText(
    "Synthetic street, 12",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "Synthetic street, 12",
  );
  await page
    .context()
    .setGeolocation({ latitude: 37.963, longitude: 58.32, accuracy: 10 });
  await expect(page.getByLabel("Местоположение GPS")).not.toContainText(
    "Synthetic street",
  );
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "37.9630, 58.3200",
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Уйти с линии", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  expect(requests).toHaveLength(2);
  const refresh = page.getByRole("button", {
    name: "Обновить адрес",
    exact: true,
  });
  await expect(refresh).toBeDisabled();
  expect(requests).toHaveLength(2);
  await login(page, "admin");
  await page.goto(`/adminDrivers/${created.id}`);
  await expect(page.getByText("GPS", { exact: true })).toBeVisible();
  await page.waitForTimeout(400);
  expect(requests).toHaveLength(2);
});

test("a due visible shift refreshes at the unchanged GPS point and reconnect never bursts", async ({
  page,
}) => {
  const driver = await createAddressDriver(page, "+99360000327");
  await startGps(page, {
    latitude: 37.961234,
    longitude: 58.321234,
    accuracy: 10,
  });
  const onlineResponse = page.waitForResponse(
    (response) =>
      /\/geo\/drivers\/[^/]+\/address/.test(response.url()) &&
      response.request().postDataJSON().purpose === "online",
  );
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  expect((await onlineResponse).ok()).toBe(true);
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "Synthetic street, 12",
  );
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
  });
  const prisma = new PrismaClient();
  try {
    await prisma.driverAddressState.update({
      where: { driverId: driver.id },
      data: {
        attemptedAt: new Date(Date.now() - 360_000),
        purpose: "shift",
        onlineExceptionReady: false,
        pendingUntil: null,
        address: null,
        cacheUntil: null,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
  await page.evaluate((id) => {
    localStorage.setItem(
      `tayyn.address.${id}.synthetic-approved-browser`,
      JSON.stringify({ consumed: true, retryAt: Date.now() - 1000 }),
    );
  }, driver.id);
  const purposes: string[] = [];
  page.on("request", (request) => {
    if (/\/geo\/drivers\/[^/]+\/address/.test(request.url()))
      purposes.push(request.postDataJSON().purpose);
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toHaveAttribute("data-state", "ready");
  expect(purposes).toEqual([]);
  const response = page.waitForResponse((response) =>
    /\/geo\/drivers\/[^/]+\/address/.test(response.url()),
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect((await response).ok()).toBe(true);
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "Synthetic street, 12",
  );
  expect(purposes).toEqual(["refresh"]);
  await page.evaluate(() => {
    for (const state of ["hidden", "visible"]) {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }
  });
  await page.context().setOffline(true);
  await page.context().setOffline(false);
  await expect(
    page.getByRole("button", { name: "Уйти с линии", exact: true }),
  ).toHaveAttribute("title", "На линии. Связь с диспетчером установлена.");
  await page.waitForTimeout(1100);
  expect(purposes).toEqual(["refresh"]);
});

test("a shared address deadline refreshes when the server allows it instead of adding five minutes", async ({
  page,
}) => {
  const driver = await createAddressDriver(page, "+99360000328");
  await startGps(page, {
    latitude: 37.961234,
    longitude: 58.321234,
    accuracy: 10,
  });
  const initialOnline = page.waitForResponse(
    (response) =>
      /\/geo\/drivers\/[^/]+\/address/.test(response.url()) &&
      response.request().postDataJSON().purpose === "online",
  );
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  expect((await initialOnline).ok()).toBe(true);
  await page.addInitScript(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
  });
  await page.evaluate((id) => {
    localStorage.setItem(
      `tayyn.address.${id}.synthetic-approved-browser`,
      JSON.stringify({ consumed: true, retryAt: Date.now() - 1000 }),
    );
  }, driver.id);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toHaveAttribute("data-state", "ready");
  const prisma = new PrismaClient();
  try {
    // Another viewer spent most of the shared cooldown before this phone asks.
    await prisma.driverAddressState.update({
      where: { driverId: driver.id },
      data: {
        attemptedAt: new Date(Date.now() - 290_000),
        purpose: "shift",
        onlineExceptionReady: false,
        pendingUntil: null,
        address: null,
        cacheUntil: null,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
  const limited = page.waitForResponse((response) =>
    /\/geo\/drivers\/[^/]+\/address/.test(response.url()),
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect((await (await limited).json()).reason).toBe("limited");
  const refreshed = page.waitForResponse(
    (response) => /\/geo\/drivers\/[^/]+\/address/.test(response.url()),
    { timeout: 15_000 },
  );
  expect((await (await refreshed).json()).reason).toBe("resolved");
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "Synthetic street, 12",
  );
});

test("relaunch preserves a pending Online address demand through the shared cooldown", async ({
  page,
}) => {
  await createAddressDriver(page, "+99360000329");
  await startGps(page, {
    latitude: 37.961234,
    longitude: 58.321234,
    accuracy: 10,
  });
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "Synthetic street, 12",
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let serverFinished!: () => void;
  const providerReply = new Promise<void>((resolve) => {
    serverFinished = resolve;
  });
  await page.route("**/geo/drivers/*/address", async (route) => {
    if (route.request().postDataJSON().purpose !== "online") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    serverFinished();
    await gate;
    if (!route.request().failure()) await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  await providerReply;
  await expect(
    page.getByRole("button", { name: "Уйти с линии", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const resumed = page.waitForResponse(
    (response) => /\/geo\/drivers\/[^/]+\/address/.test(response.url()),
    { timeout: 7000 },
  );
  await page.reload();
  release();
  const reply = await resumed;
  expect(reply.ok()).toBe(true);
  expect(reply.request().postDataJSON().purpose).toBe("online");
  expect((await reply.json()).reason).toBe("limited");
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toHaveAttribute("data-state", "ready");
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

test("authenticated actor shells show exactly one brand at mobile, tablet and desktop widths", async ({
  page,
}) => {
  for (const role of ["admin", "driver"] as const) {
    await login(page, role);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      for (const dark of [false, true]) {
        await page.evaluate(
          (value) => document.documentElement.classList.toggle("dark", value),
          dark,
        );
        await expect(page.locator(".brand-lockup:visible")).toHaveCount(1);
        if (role === "admin") {
          await expect(page.locator(".connection")).toContainText("На связи");
        } else {
          await expect(
            page.locator(".workspace-header .connection"),
          ).toHaveCount(0);
          await expect(
            page.getByRole("button", {
              name: "Связь с диспетчером",
              exact: true,
            }),
          ).toHaveAttribute("data-state", "ready");
        }
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBeLessThanOrEqual(width);
      }
    }
  }
});

test("underfunded public orders stay visible with disabled acceptance and a top-up explanation", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const driverContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage();
    const driver = await driverContext.newPage();
    await login(admin, "admin");
    const adminToken = await admin.evaluate(() =>
      localStorage.getItem("openride.admin.accessToken"),
    );
    const headers = { Authorization: `Bearer ${adminToken}` };
    const created = await admin.request.post(
      `${process.env.TEST_API_URL}/admin/drivers`,
      {
        headers,
        data: {
          fullName: "Недостаточно средств",
          phone: "+99360000415",
          password,
        },
      },
    );
    expect(created.ok()).toBe(true);
    const driverId = (await created.json()).id;
    expect(
      (
        await admin.request.post(
          `${process.env.TEST_API_URL}/admin/drivers/${driverId}/balance`,
          {
            headers,
            data: {
              operationId: crypto.randomUUID(),
              amount: 15,
              type: "TOPUP",
            },
          },
        )
      ).ok(),
    ).toBe(true);
    await login(driver, "driver", "+99360000415");
    await startGps(driver);
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      driver.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const order = await admin.request.post(
      `${process.env.TEST_API_URL}/admin/orders`,
      {
        headers,
        data: {
          districtId: process.env.TEST_REGION_ID,
          priceEstimated: 30,
          clientPhone: "+99360000999",
          pickupAddress: "Проверка средств",
        },
      },
    );
    expect(order.ok()).toBe(true);
    await expect(
      driver.getByText("Проверка средств", { exact: true }),
    ).toBeVisible();
    await expect(
      driver.getByRole("button", { name: "Принять заказ", exact: true }),
    ).toBeDisabled();
    await expect(
      driver.getByText(/Недостаточно средств\. Пополните баланс до/),
    ).toBeVisible();
    await driver
      .getByRole("button", { name: "Скрыть предложение", exact: true })
      .click();
    await driver
      .getByRole("group", { name: "Регионы", exact: true })
      .getByRole("button", { name: /Мой район/ })
      .click();
    const card = driver
      .getByRole("article")
      .filter({ hasText: "Проверка средств" });
    await expect(
      card.getByRole("button", { name: "Принять заказ", exact: true }),
    ).toBeDisabled();
    await expect(
      card.getByText(/Недостаточно средств\. Пополните баланс до/),
    ).toBeVisible();
  } finally {
    await adminContext.close();
    await driverContext.close();
  }
});

test("private offer picker disables an online driver whose balance cannot cover the quote", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const driverContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage(),
      driver = await driverContext.newPage();
    await login(admin, "admin");
    const adminToken = await admin.evaluate(() =>
      localStorage.getItem("openride.admin.accessToken"),
    );
    const headers = { Authorization: `Bearer ${adminToken}` };
    const created = await admin.request.post(
      `${process.env.TEST_API_URL}/admin/drivers`,
      {
        headers,
        data: {
          fullName: "Личное без средств",
          phone: "+99360000416",
          password,
        },
      },
    );
    expect(created.ok()).toBe(true);
    const driverId = (await created.json()).id;
    expect(
      (
        await admin.request.post(
          `${process.env.TEST_API_URL}/admin/drivers/${driverId}/balance`,
          {
            headers,
            data: {
              operationId: crypto.randomUUID(),
              amount: 15,
              type: "TOPUP",
            },
          },
        )
      ).ok(),
    ).toBe(true);
    await login(driver, "driver", "+99360000416");
    await startGps(driver);
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      driver.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await admin.goto("/adminOrders");
    await admin
      .getByRole("button", { name: "Создать заказ", exact: true })
      .click();
    const dialog = admin.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Лично водителю", exact: true })
      .click();
    await dialog.getByLabel("Стоимость, TMT").fill("30");
    const option = dialog.getByRole("option", { name: /Личное без средств/ });
    await expect(option).toBeDisabled();
    await expect(option).toContainText("недостаточно средств");
    await dialog.getByLabel("Стоимость, TMT").fill("15");
    await expect(option).toBeEnabled();
  } finally {
    await adminContext.close();
    await driverContext.close();
  }
});

test("a fresh local GPS fix starts the shift atomically and Offline stops location uploads", async ({
  page,
}) => {
  await login(page, "driver");
  await startGps(page);
  let uploads = 0;
  await page.route("**/driver/location", async (route) => {
    uploads++;
    await route.continue();
  });
  const shiftStarted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/driver/status") &&
      response.request().postDataJSON()?.isOnline === true,
  );
  await page
    .getByRole("button", { name: "Выйти на линию", exact: true })
    .click();
  const started = await shiftStarted;
  expect(started.ok()).toBe(true);
  expect(started.request().postDataJSON().position).toMatchObject({
    lat: 37.96,
    lng: 58.32,
    accuracy: 10,
  });
  await expect(
    page.getByRole("button", { name: "Уйти с линии", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Уйти с линии", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Выйти на линию", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Последнее обновление/)).toBeVisible();
  const uploadsAtOffline = uploads;
  await page
    .context()
    .setGeolocation({ latitude: 37.97, longitude: 58.33, accuracy: 10 });
  await page.getByRole("button", { name: "Включить GPS", exact: true }).click();
  await expect(page.getByLabel("Местоположение GPS")).toContainText(
    "37.9700, 58.3300",
  );
  expect(uploads).toBe(uploadsAtOffline);
});

test("dispatcher driver details follow fresh location events without a manual refresh", async ({
  page,
}) => {
  const created = await createAddressDriver(page, "+99360000324");
  const token = await page.evaluate(() =>
    localStorage.getItem("openride.driver.accessToken"),
  );
  await login(page, "admin");
  await page.goto(`/adminDrivers/${created.id}`);
  await expect(page.getByText("Нет координат", { exact: true })).toBeVisible();
  await page.getByLabel("Марка", { exact: true }).fill("Draft vehicle make");
  const report = await page.request.post(
    `${process.env.TEST_API_URL}/driver/status`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        isOnline: true,
        position: {
          lat: 37.96,
          lng: 58.32,
          accuracy: 10,
          capturedAt: Date.now(),
        },
      },
    },
  );
  expect(report.ok()).toBe(true);
  await expect(
    page.getByText("37.96000, 58.32000", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Марка", { exact: true })).toHaveValue(
    "Draft vehicle make",
  );
});

test("dispatcher can load older chat and a lost send response retries without duplicating", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const driverContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage();
    const driver = await driverContext.newPage();
    await login(admin, "admin");
    await login(driver, "driver");
    const token = await driver.evaluate(() =>
      localStorage.getItem("openride.driver.accessToken"),
    );
    const profile = await driverContext.request.get(
      `${process.env.TEST_API_URL}/driver/profile`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const driverId = (await profile.json()).id;
    for (let i = 0; i < 105; i++) {
      const result = await driverContext.request.post(
        `${process.env.TEST_API_URL}/driver/messages`,
        {
          headers: { Authorization: `Bearer ${token}` },
          data: { body: `Older history ${i}` },
        },
      );
      expect(result.ok()).toBe(true);
    }
    await admin.goto(`/adminChat/${driverId}`);
    await expect(
      admin.getByText("Older history 104", { exact: true }),
    ).toBeAttached();
    await expect(
      admin.getByText("Older history 0", { exact: true }),
    ).toHaveCount(0);
    await admin
      .getByRole("button", { name: "Загрузить более ранние сообщения" })
      .click();
    await expect(
      admin.getByText("Older history 0", { exact: true }),
    ).toBeAttached();
    await driver.goto("/driverChat");
    let dropped = false;
    await driver.route("**/driver/messages", async (route) => {
      if (route.request().method() === "POST" && !dropped) {
        dropped = true;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    });
    const composer = driver.getByLabel("Сообщение диспетчеру");
    await composer.fill("Retry once without duplicate");
    await composer.press("Enter");
    await expect(composer).toHaveValue("Retry once without duplicate");
    await expect(
      driver.getByRole("button", { name: "Отправить сообщение", exact: true }),
    ).toBeEnabled();
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    const history = await driverContext.request.get(
      `${process.env.TEST_API_URL}/driver/messages`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    expect(
      (await history.json()).items.filter(
        (message: { body: string }) =>
          message.body === "Retry once without duplicate",
      ),
    ).toHaveLength(1);
  } finally {
    await adminContext.close();
    await driverContext.close();
  }
});

test("a hidden driver chat does not mark arriving messages as read", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const driverContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage();
    const driver = await driverContext.newPage();
    await login(admin, "admin");
    await login(driver, "driver");
    await driver.goto("/driverChat");
    await expect(driver.getByLabel("Сообщение диспетчеру")).toBeVisible();
    await driver.evaluate(() =>
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      }),
    );
    const driverToken = await driver.evaluate(() =>
      localStorage.getItem("openride.driver.accessToken"),
    );
    const adminToken = await admin.evaluate(() =>
      localStorage.getItem("openride.admin.accessToken"),
    );
    const profile = await driverContext.request.get(
      `${process.env.TEST_API_URL}/driver/profile`,
      { headers: { Authorization: `Bearer ${driverToken}` } },
    );
    const driverId = (await profile.json()).id;
    await adminContext.request.post(
      `${process.env.TEST_API_URL}/admin/messages`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { driverId, body: "Keep this unread while hidden" },
      },
    );
    await expect(
      driver.getByText("Keep this unread while hidden", { exact: true }),
    ).toBeAttached();
    const history = await driverContext.request.get(
      `${process.env.TEST_API_URL}/driver/messages`,
      { headers: { Authorization: `Bearer ${driverToken}` } },
    );
    expect((await history.json()).unread).toBeGreaterThan(0);
    await driver.evaluate(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect
      .poll(async () => {
        const result = await driverContext.request.get(
          `${process.env.TEST_API_URL}/driver/messages`,
          { headers: { Authorization: `Bearer ${driverToken}` } },
        );
        return (await result.json()).unread;
      })
      .toBe(0);
  } finally {
    await adminContext.close();
    await driverContext.close();
  }
});

test("monitoring keeps a claimed driver busy across delayed snapshots and reconnect", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const fullName = `Проверка занятого водителя ${test.info().repeatEachIndex}`;
  const phone = `+993600004${51 + test.info().repeatEachIndex}`;
  const adminContext = await browser.newContext();
  const driverContext = await browser.newContext();
  let releaseSnapshot: (() => void) | undefined;
  try {
    const admin = await adminContext.newPage();
    const driver = await driverContext.newPage();
    await login(admin, "admin");
    const adminToken = await admin.evaluate(() =>
      localStorage.getItem("openride.admin.accessToken"),
    );
    const headers = { Authorization: `Bearer ${adminToken}` };
    const created = await admin.request.post(
      `${process.env.TEST_API_URL}/admin/drivers`,
      {
        headers,
        data: {
          fullName,
          phone,
          password,
        },
      },
    );
    expect(created.ok()).toBe(true);
    const driverId = (await created.json()).id;
    const funded = await admin.request.post(
      `${process.env.TEST_API_URL}/admin/drivers/${driverId}/balance`,
      {
        headers,
        data: { operationId: crypto.randomUUID(), amount: 100, type: "TOPUP" },
      },
    );
    expect(funded.ok()).toBe(true);
    await login(driver, "driver", phone);
    await startGps(driver);
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      driver.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const driverToken = await driver.evaluate(() =>
      localStorage.getItem("openride.driver.accessToken"),
    );
    const driverHeaders = { Authorization: `Bearer ${driverToken}` };
    expect(
      (
        await driver.request.post(
          `${process.env.TEST_API_URL}/driver/location`,
          { headers: driverHeaders, data: { lat: 37.96, lng: 58.32 } },
        )
      ).ok(),
    ).toBe(true);
    expect(
      (
        await driver.request.post(`${process.env.TEST_API_URL}/driver/status`, {
          headers: driverHeaders,
          data: { isOnline: true },
        })
      ).ok(),
    ).toBe(true);
    await admin.goto("/adminMonitoring");
    const row = admin.getByRole("button", {
      name: fullName,
      exact: true,
    });
    await expect(row).toContainText("Свободен");
    await row.click();
    await expect(
      admin.getByRole("button", { name: "Предложить заказ", exact: true }),
    ).toBeEnabled();
    // Hold an actual pre-claim HTTP snapshot while a real Socket.IO claim arrives.
    let snapshotCaptured!: () => void;
    const captured = new Promise<void>((resolve) => {
      snapshotCaptured = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let finishSnapshot!: () => void;
    const finishedSnapshot = new Promise<void>((resolve) => {
      finishSnapshot = resolve;
    });
    let heldOnce = false;
    await admin.route("**/api/admin/drivers?**", async (route) => {
      if (heldOnce) return route.continue();
      heldOnce = true;
      const response = await route.fetch();
      snapshotCaptured();
      await held;
      await route.fulfill({ response });
      finishSnapshot();
    });
    await admin.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await captured;
    const orderResponse = await admin.request.post(
      `${process.env.TEST_API_URL}/admin/orders`,
      {
        headers,
        data: {
          districtId: process.env.TEST_REGION_ID,
          clientPhone: "+99360000888",
          priceEstimated: 25,
        },
      },
    );
    expect(orderResponse.ok()).toBe(true);
    const orderId = (await orderResponse.json()).id;
    expect(
      (
        await driver.request.post(`${process.env.TEST_API_URL}/orders/accept`, {
          headers: driverHeaders,
          data: { orderId, arrivalMinutes: 5 },
        })
      ).ok(),
    ).toBe(true);
    await expect(row).toContainText("В поездке");
    await expect(
      admin.getByRole("button", { name: "Предложить заказ", exact: true }),
    ).toBeDisabled();
    releaseSnapshot?.();
    await finishedSnapshot;
    await admin.unroute("**/api/admin/drivers?**");
    await expect(row).toContainText("В поездке");
    await admin.reload();
    await expect(row).toContainText("В поездке");
    const stopped = await driver.request.post(
      `${process.env.TEST_API_URL}/driver/status`,
      {
        headers: driverHeaders,
        data: { isOnline: false },
      },
    );
    expect(stopped.ok()).toBe(true);
    await expect(row).toContainText("Поездка не завершена");
    await row.click();
    const selected = admin.getByRole("region", {
      name: "Выбранный водитель",
      exact: true,
    });
    await expect(selected).toContainText("Не в сети");
    await expect(selected).toContainText("Поездка не завершена");
    await expect(selected).toContainText(
      "Последнее местоположение · обновление остановлено",
    );
    await expect(
      admin.getByRole("button", { name: "Предложить заказ", exact: true }),
    ).toBeDisabled();
    const resumed = await driver.request.post(
      `${process.env.TEST_API_URL}/driver/status`,
      {
        headers: driverHeaders,
        data: {
          isOnline: true,
          position: {
            lat: 37.96,
            lng: 58.32,
            accuracy: 10,
            capturedAt: Date.now(),
          },
        },
      },
    );
    expect(resumed.ok()).toBe(true);
    await expect(row).toContainText("В поездке");
    for (const path of ["waiting", "start", "complete"])
      expect(
        (
          await driver.request.post(
            `${process.env.TEST_API_URL}/orders/${path}`,
            { headers: driverHeaders, data: { orderId } },
          )
        ).ok(),
      ).toBe(true);
    await expect(row).toContainText("Свободен");
    await row.click();
    await expect(
      admin.getByRole("button", { name: "Предложить заказ", exact: true }),
    ).toBeEnabled();
  } finally {
    releaseSnapshot?.();
    await adminContext.close();
    await driverContext.close();
  }
});

test("today overview stays compact on mobile and separates request failure from real metrics", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.route("**/admin/overview/today", (route) => route.abort("failed"));
  await login(page, "admin");
  const today = page.getByRole("region", {
    name: "Оперативные показатели",
    exact: true,
  });
  await expect(today.getByRole("alert")).toBeVisible();
  await expect(today.getByText("Создано сегодня", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", {
      name: "Завершённые поездки за всё время",
      exact: true,
    }),
  ).toBeVisible();
  await page.unroute("**/admin/overview/today");
  await today.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(
    today.getByText("Создано сегодня", { exact: true }),
  ).toBeVisible();
  await expect(today.getByText(/Ашхабад, UTC\+5/)).toBeVisible();
  await expect(
    today.getByText(/Только заказы, созданные сегодня/),
  ).toBeVisible();
  await expect(
    today.getByText(/Сейчас ждут принятия · за все дни/),
  ).toBeVisible();
  await expect(
    today.getByText(/период доступа только своему району/),
  ).toBeVisible();
  for (const dark of [false, true]) {
    await page.evaluate(
      (value) => document.documentElement.classList.toggle("dark", value),
      dark,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(320);
    await expect(today).toBeVisible();
  }
});

test("dispatcher retries a lost wallet response without applying the adjustment twice", async ({
  page,
}) => {
  await login(page, "admin");
  const token = await page.evaluate(() =>
    localStorage.getItem("openride.admin.accessToken"),
  );
  const created = await page.request.post(
    `${process.env.TEST_API_URL}/admin/drivers`,
    {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        fullName: "Retry wallet driver",
        phone: "+99361999881",
        password,
      },
    },
  );
  expect(created.ok()).toBe(true);
  const driver = await created.json();
  await page.goto(`/adminDrivers/${driver.id}`);
  await page.getByRole("button", { name: "Баланс", exact: true }).click();
  await page.getByLabel("Сумма, TMT", { exact: true }).fill("15");
  const keys: string[] = [];
  await page.route(`**/admin/drivers/${driver.id}/balance`, async (route) => {
    const body = route.request().postDataJSON();
    keys.push(body.operationId);
    const response = await route.fetch();
    if (keys.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Пополнить", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Пополнить", exact: true }).click();
  await expect(
    page.getByText("Изменения сохранены", { exact: true }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  const history = await page.request.get(
    `${process.env.TEST_API_URL}/admin/drivers/${driver.id}/history`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const ledger = await history.json();
  expect(ledger.transactions.total).toBe(1);
  expect(ledger.transactions.items[0].balanceAfter).toBe("15");
});

test("driver cancellation is visible only while waiting for the passenger", async ({
  browser,
}) => {
  const adminContext = await browser.newContext(),
    driverContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage(),
      driver = await driverContext.newPage();
    await login(admin, "admin");
    await login(driver, "driver");
    await startGps(driver);
    await driver
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    const adminToken = await admin.evaluate(() =>
      localStorage.getItem("openride.admin.accessToken"),
    );
    const driverToken = await driver.evaluate(() =>
      localStorage.getItem("openride.driver.accessToken"),
    );
    const created = await admin.request.post(
      `${process.env.TEST_API_URL}/admin/orders`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: {
          districtId: process.env.TEST_REGION_ID,
          clientPhone: "+99365000000",
          priceEstimated: 10,
        },
      },
    );
    expect(created.ok()).toBe(true);
    const orderId = (await created.json()).id;
    expect(
      (
        await driver.request.post(`${process.env.TEST_API_URL}/orders/accept`, {
          headers: { Authorization: `Bearer ${driverToken}` },
          data: { orderId },
        })
      ).ok(),
    ).toBe(true);
    const trip = driver.getByRole("dialog", {
      name: "Управление поездкой",
      exact: true,
    });
    await expect(trip).toBeVisible();
    await expect(
      trip.getByRole("button", { name: "Отменить заказ", exact: true }),
    ).toHaveCount(0);
    await trip.getByRole("button", { name: "Я на месте", exact: true }).click();
    await expect(
      trip.getByRole("button", { name: "Отменить заказ", exact: true }),
    ).toBeVisible();
    await trip
      .getByRole("button", { name: "Начать поездку", exact: true })
      .click();
    await expect(
      trip.getByRole("button", { name: "Отменить заказ", exact: true }),
    ).toHaveCount(0);
    await expect(
      trip.getByRole("button", { name: "Завершить поездку", exact: true }),
    ).toBeEnabled();
    await trip
      .getByRole("button", { name: "Завершить поездку", exact: true })
      .click();
    await expect(trip).toBeHidden();
    // Finishing a trip can immediately show another live offer. End the fixture
    // shift through the public API without clicking through that new modal.
    expect(
      (
        await driver.request.post(`${process.env.TEST_API_URL}/driver/status`, {
          headers: { Authorization: `Bearer ${driverToken}` },
          data: { isOnline: false },
        })
      ).ok(),
    ).toBe(true);
  } finally {
    await adminContext.close();
    await driverContext.close();
  }
});

for (const stage of [
  "pickup",
  "dropoff",
  "missing-destination",
  "invalid-pickup",
  "invalid-destination",
] as const) {
  test(`trip navigation uses ${stage} and preserves the active shift`, async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const driverContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const admin = await adminContext.newPage(),
      driver = await driverContext.newPage();
    let driverToken = "",
      orderId = "";
    const pickupStage = stage === "pickup" || stage === "invalid-pickup";
    const unavailableTarget =
      stage === "missing-destination" ||
      stage === "invalid-pickup" ||
      stage === "invalid-destination";
    try {
      await login(admin, "admin");
      await login(driver, "driver");
      await startGps(driver);
      await driver
        .getByRole("button", { name: "Выйти на линию", exact: true })
        .click();
      const adminToken = await admin.evaluate(() =>
        localStorage.getItem("openride.admin.accessToken"),
      );
      driverToken = (await driver.evaluate(() =>
        localStorage.getItem("openride.driver.accessToken"),
      ))!;
      const created = await admin.request.post(
        `${process.env.TEST_API_URL}/admin/orders`,
        {
          headers: { Authorization: `Bearer ${adminToken}` },
          data: {
            districtId: process.env.TEST_REGION_ID,
            clientPhone: "+99365000000",
            priceEstimated: 10,
            pickupLat: stage === "invalid-pickup" ? 0 : 37.961,
            pickupLng: stage === "invalid-pickup" ? 0 : 58.321,
            ...(stage !== "missing-destination"
              ? {
                  dropoffLat: stage === "invalid-destination" ? 0 : 37.972,
                  dropoffLng: stage === "invalid-destination" ? 0 : 58.332,
                }
              : {}),
          },
        },
      );
      expect(created.ok()).toBe(true);
      orderId = (await created.json()).id;
      const action = (name: string) =>
        driver.request.post(`${process.env.TEST_API_URL}/orders/${name}`, {
          headers: { Authorization: `Bearer ${driverToken}` },
          data: { orderId },
        });
      expect((await action("accept")).ok()).toBe(true);
      const trip = driver.getByRole("dialog", {
        name: "Управление поездкой",
        exact: true,
      });
      await expect(trip).toBeVisible();
      if (!pickupStage) {
        await trip
          .getByRole("button", { name: "Я на месте", exact: true })
          .click();
        await trip
          .getByRole("button", { name: "Начать поездку", exact: true })
          .click();
        await expect(
          trip.getByRole("button", { name: "Завершить поездку", exact: true }),
        ).toBeVisible();
      }
      const routeName = pickupStage
        ? "Маршрут до подачи"
        : "Маршрут до назначения";
      if (unavailableTarget) {
        await expect(
          trip.getByRole("button", { name: /Маршрут до/ }),
        ).toHaveCount(0);
      } else {
        await expect(
          trip.getByRole("button", { name: routeName, exact: true }),
        ).toBeVisible();
      }
      await trip.getByRole("button", { name: "Close", exact: true }).click();
      const feed = driver.getByRole("region", {
        name: "Текущая поездка",
        exact: true,
      });
      if (unavailableTarget) {
        await expect(
          feed.getByRole("button", { name: /Маршрут до/ }),
        ).toHaveCount(0);
      } else {
        // The installed-map handler is an external platform boundary. In a
        // browser without that handler, observe the real public web fallback.
        await driver.route("https://yandex.ru/maps/**", (route) =>
          route.abort(),
        );
        const requested = driver.waitForRequest("https://yandex.ru/maps/**");
        await feed
          .getByRole("button", { name: routeName, exact: true })
          .click();
        const url = new URL((await requested).url());
        expect(url.searchParams.get("rtext")).toBe(
          stage === "pickup" ? "~37.961,58.321" : "~37.972,58.332",
        );
        expect(url.searchParams.get("rtt")).toBe("auto");
      }
      const profile = await driver.request.get(
        `${process.env.TEST_API_URL}/driver/profile`,
        {
          headers: { Authorization: `Bearer ${driverToken}` },
        },
      );
      expect((await profile.json()).isOnline).toBe(true);
      const currentOrder = await driver.request.get(
        `${process.env.TEST_API_URL}/orders/current`,
        { headers: { Authorization: `Bearer ${driverToken}` } },
      );
      expect(currentOrder.ok()).toBe(true);
      expect(await currentOrder.json()).toMatchObject({ id: orderId });
    } finally {
      if (driverToken && orderId) {
        for (const name of ["waiting", "start", "complete"]) {
          await driver.request.post(
            `${process.env.TEST_API_URL}/orders/${name}`,
            {
              headers: { Authorization: `Bearer ${driverToken}` },
              data: { orderId },
            },
          );
        }
        await driver.request.post(`${process.env.TEST_API_URL}/driver/status`, {
          headers: { Authorization: `Bearer ${driverToken}` },
          data: { isOnline: false },
        });
      }
      await adminContext.close();
      await driverContext.close();
    }
  });
}
