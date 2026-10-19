import { test, expect, type Page } from "@playwright/test";
import {
  isolateBrowserClient,
  loginFixture,
  installFixtureSession,
} from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");

async function signupForm(page: Page, phone: string) {
  await isolateBrowserClient(page.context());
  await page.goto("/driverRegister");
  await page.getByLabel("Имя и фамилия").fill("Новый водитель");
  await page.getByLabel("Номер телефона").fill(phone);
  await page.getByLabel("Пароль", { exact: true }).fill("123456");
}
async function login(page: Page, phone: string, password: string) {
  await page.getByLabel("Номер телефона").fill(phone);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/driverDashboard/);
}

for (const logout of [false, true]) {
  test(`late registration cannot replace a session after navigation${logout ? " and logout" : ""}`, async ({
    page,
  }) => {
    await signupForm(page, logout ? "61999062" : "61999061");
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen = new Promise<void>((resolve) => (reached = resolve));
    await page.route("**/api/auth/register", async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      reached();
      await gate;
      await route.fulfill({ response }).catch(() => {});
    });
    await page
      .getByRole("button", { name: "Создать аккаунт", exact: true })
      .click();
    await seen;
    await page.getByRole("link", { name: "Войти", exact: true }).click();
    await login(page, "60000101", process.env.TEST_ACCOUNT_PASSWORD!);
    const before = await page.evaluate(() =>
      localStorage.getItem("openride.driver.accessToken"),
    );
    if (logout) {
      await page.getByRole("link", { name: "Профиль", exact: true }).click();
      await page.getByRole("button", { name: "Выйти", exact: true }).click();
      await expect(page).toHaveURL(/driverLogin/);
    }
    release();
    await page.unrouteAll({ behavior: "wait" });
    expect(
      await page.evaluate(() =>
        localStorage.getItem("openride.driver.accessToken"),
      ),
    ).toBe(logout ? null : before);
    await expect(page).toHaveURL(logout ? /driverLogin/ : /driverDashboard/);
    if (!logout)
      expect(
        JSON.parse(
          (await page.evaluate(() =>
            localStorage.getItem("tayyn.driver.user"),
          ))!,
        ).phone,
      ).toBe("+99360000101");
  });
}

test("a lost signup response recovers through ordinary login without another signup", async ({
  page,
}) => {
  await signupForm(page, "61999063");
  let registrations = 0;
  await page.route("**/api/auth/register", async (route) => {
    registrations++;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort("failed");
  });
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Попробуйте войти с этим номером и паролем",
  );
  await expect(
    page.getByRole("button", { name: "Создать аккаунт", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("link", { name: "Перейти ко входу", exact: true })
    .click();
  await login(page, "61999063", "123456");
  expect(registrations).toBe(1);
  await page.reload();
  await expect(
    page.getByRole("navigation", { name: "Разделы водителя" }),
  ).toBeVisible();
});

test("signup with an existing phone points to sign-in without changing the account", async ({
  page,
}) => {
  await isolateBrowserClient(page.context());
  const existing = await page.request.post(
    `${process.env.TEST_API_URL}/auth/register`,
    {
      data: {
        fullName: "Существующий аккаунт",
        phone: "+99361999065",
        password: "123456",
        deviceId: "existing-signup-fixture",
      },
    },
  );
  expect(existing.status()).toBe(201);
  await signupForm(page, "61999065");
  await page.getByLabel("Пароль", { exact: true }).fill("654321");
  await page
    .getByRole("button", { name: "Создать аккаунт", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Этот номер уже зарегистрирован. Войдите или обратитесь к диспетчеру.",
  );
  await page
    .getByRole("link", { name: "Перейти ко входу", exact: true })
    .click();
  await login(page, "61999065", "123456");
  expect(
    JSON.parse(
      (await page.evaluate(() => localStorage.getItem("tayyn.driver.user")))!,
    ).fullName,
  ).toBe("Существующий аккаунт");
});

test("mobile dispatcher overview, driver list and detail have active accounts without approval controls", async ({
  page,
}) => {
  await isolateBrowserClient(page.context());
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await loginFixture(page.request, "+99360000000");
  await installFixtureSession(page.context(), "admin", admin);
  const created = await page.request.post(
    `${process.env.TEST_API_URL}/auth/register`,
    {
      data: {
        fullName: "Мобильный аккаунт",
        phone: "+99361999064",
        password: "123456",
        deviceId: "mobile-signup-fixture",
      },
    },
  );
  expect(created.status()).toBe(201);
  const { user } = await created.json();
  await page.goto("/adminDashboard");
  await expect(
    page.getByRole("link", { name: /Активные заказы/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Водители на линии/ }),
  ).toBeVisible();
  await expect(
    page.getByText(/Ожидают проверки|Одобрить|На проверке/),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.goto("/adminDrivers?status=PENDING");
  const filter = page.getByLabel("Статус водителя");
  await expect(filter).toHaveValue("");
  expect(await filter.locator("option").allTextContents()).toEqual([
    "Все статусы",
    "Активны",
    "Заблокированы",
  ]);
  await expect(
    page.getByRole("link", { name: /Мобильный аккаунт/ }),
  ).toBeVisible();
  await page.goto(`/adminDrivers/${user.driver.id}`);
  await expect(
    page.getByRole("heading", { name: "Мобильный аккаунт", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Активен", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Заблокировать", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Одобрить", exact: true }),
  ).toHaveCount(0);
});
