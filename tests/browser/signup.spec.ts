import { test, expect, type Page } from "@playwright/test";
import {
  isolateBrowserClient,
  loginFixture,
  installFixtureSession,
} from "./helpers/device-session";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");

async function applicationForm(page: Page, phone: string, name: string) {
  await isolateBrowserClient(page.context());
  await page.goto("/driverRegister");
  await page.getByLabel("Имя и фамилия").fill(name);
  await page.getByLabel("Номер телефона").fill(phone);
  await page.getByLabel("Пароль", { exact: true }).fill("123456");
}
async function submitLogin(page: Page, phone: string, password: string) {
  await page.getByLabel("Номер телефона").fill(phone);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
}
async function apply(page: Page, phone: string, fullName: string) {
  const response = await page.request.post(
    `${process.env.TEST_API_URL}/auth/register`,
    { data: { fullName, phone, password: "123456" } },
  );
  expect(response.status()).toBe(201);
  return (await response.json()) as { user: { driver: { id: string } } };
}

test("an application waits for dispatcher approval before the driver can sign in", async ({
  page,
}) => {
  await applicationForm(page, "61999061", "Ожидающий водитель");
  await expect(
    page.getByRole("heading", { name: "Стать водителем", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Создайте аккаунт и дождитесь одобрения диспетчера."),
  ).toBeVisible();
  const registration = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/register") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Отправить заявку", exact: true })
    .click();
  expect((await registration).status()).toBe(201);
  await expect(page.getByRole("status")).toHaveText(
    "Заявка отправлена. Диспетчер проверит ваш аккаунт. После одобрения войдите с этим номером.",
  );
  await expect(page.getByLabel("Пароль", { exact: true })).toHaveValue("");
  await expect(page).toHaveURL(/driverRegister/);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("openride.driver.accessToken"),
    ),
  ).toBeNull();

  await page.getByRole("link", { name: "Войти", exact: true }).click();
  await submitLogin(page, "61999061", "123456");
  await expect(page.getByRole("alert")).toHaveText(
    "Ваш аккаунт ожидает подтверждения",
  );
  await expect(page).toHaveURL(/driverLogin/);

  const admin = await loginFixture(page.request, "+99360000000");
  const drivers = await page.request.get(
    `${process.env.TEST_API_URL}/admin/drivers?status=PENDING&limit=100`,
    { headers: { Authorization: `Bearer ${admin.accessToken}` } },
  );
  const pending = (await drivers.json()).items.find(
    (driver: { user: { phone: string } }) =>
      driver.user.phone === "+99361999061",
  );
  const approved = await page.request.post(
    `${process.env.TEST_API_URL}/admin/drivers/${pending.id}/approve`,
    { headers: { Authorization: `Bearer ${admin.accessToken}` }, data: {} },
  );
  expect(approved.status()).toBe(200);

  await submitLogin(page, "61999061", "123456");
  await expect(page).toHaveURL(/driverDashboard/);
  await expect(
    page.getByRole("navigation", { name: "Разделы водителя" }),
  ).toBeVisible();
});

test("an application with an existing phone shows sign-in guidance without changing the account", async ({
  page,
}) => {
  await isolateBrowserClient(page.context());
  await apply(page, "+99361999065", "Существующая заявка");
  await applicationForm(page, "61999065", "Повторная заявка");
  await page
    .getByRole("button", { name: "Отправить заявку", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Этот номер уже зарегистрирован. Войдите или обратитесь к диспетчеру.",
  );
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("a late application response after leaving the form shows no stale notice", async ({
  page,
}) => {
  await applicationForm(page, "61999062", "Поздняя заявка");
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
    .getByRole("button", { name: "Отправить заявку", exact: true })
    .click();
  await seen;
  await page.getByRole("link", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/driverLogin/);
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Войти", exact: true }),
  ).toBeEnabled();
});

test("mobile dispatcher sees a new application live and approves it from the driver card", async ({
  page,
}) => {
  await isolateBrowserClient(page.context());
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await loginFixture(page.request, "+99360000000");
  await installFixtureSession(page.context(), "admin", admin);
  await page.goto("/adminDashboard");
  const tile = page.getByRole("link", { name: /Ожидают проверки/ });
  await expect(tile).toBeVisible();
  const count = async () =>
    Number((await tile.locator("p").first().textContent())?.trim());
  const before = await count();
  const { user } = await apply(page, "+99361999064", "Мобильная заявка");
  await expect.poll(count).toBe(before + 1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  await tile.click();
  await expect(page).toHaveURL(/adminDrivers\?status=PENDING/);
  const filter = page.getByLabel("Статус водителя");
  await expect(filter).toHaveValue("PENDING");
  expect(await filter.locator("option").allTextContents()).toEqual([
    "Все статусы",
    "На проверке",
    "Одобрены",
    "Заблокированы",
  ]);
  await page.getByRole("link", { name: /Мобильная заявка/ }).click();
  await expect(page).toHaveURL(new RegExp(`/adminDrivers/${user.driver.id}`));
  await expect(
    page.getByRole("heading", { name: "Мобильная заявка", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("На проверке", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Одобрить", exact: true }).click();
  await expect(page.getByText("Одобрен", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Одобрить", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Заблокировать", exact: true }),
  ).toBeVisible();
});
