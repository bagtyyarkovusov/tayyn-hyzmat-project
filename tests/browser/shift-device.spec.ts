import { test, expect, type Page } from "@playwright/test";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");
const api = process.env.TEST_API_URL!;
const password = process.env.TEST_ACCOUNT_PASSWORD!;

async function login(
  page: Page,
  role: "admin" | "driver",
  phone: string,
  deviceId: string,
) {
  await page.context().setExtraHTTPHeaders({
    "X-Forwarded-For": `198.19.0.${deviceId === "owner" ? 11 : deviceId === "spectator" ? 12 : 13}`,
  });
  await page.addInitScript(
    (id) => localStorage.setItem("openride.driver.deviceId", id),
    deviceId,
  );
  await page.goto(role === "admin" ? "/adminLogin" : "/driverLogin");
  await page.getByLabel("Номер телефона").fill(phone);
  await page.getByLabel("Пароль", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
}
async function headers(page: Page, role: "admin" | "driver") {
  const token = await page.evaluate(
    (role) => localStorage.getItem(`openride.${role}.accessToken`),
    role,
  );
  return { Authorization: `Bearer ${token}` };
}

test("second device signs in immediately without ending or controlling the first device's shift", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const adminContext = await browser.newContext();
  const ownerContext = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const spectatorContext = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 37.961, longitude: 58.321, accuracy: 10 },
  });
  const phone = "+99360000741";
  try {
    const admin = await adminContext.newPage();
    const owner = await ownerContext.newPage();
    const spectator = await spectatorContext.newPage();
    await login(admin, "admin", "+99360000000", "admin");
    await expect(admin).toHaveURL(/adminDashboard/);
    const adminHeaders = await headers(admin, "admin");
    const created = await admin.request.post(`${api}/admin/drivers`, {
      headers: adminHeaders,
      data: { fullName: "Two device shift test", phone, password },
    });
    expect(created.ok()).toBe(true);
    const { id } = await created.json();
    expect(
      (
        await admin.request.post(`${api}/admin/drivers/${id}/balance`, {
          headers: adminHeaders,
          data: {
            operationId: crypto.randomUUID(),
            amount: 100,
            type: "TOPUP",
          },
        })
      ).ok(),
    ).toBe(true);
    await login(owner, "driver", phone, "owner");
    await expect(owner).toHaveURL(/driverDashboard/);
    await login(spectator, "driver", phone, "spectator");
    await expect(spectator).toHaveURL(/driverDashboard/);
    await owner.reload();
    await expect(owner).toHaveURL(/driverDashboard/);
    const offShiftRequests: string[] = [];
    for (const page of [owner, spectator])
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith("/driver/location"))
          offShiftRequests.push(request.url());
      });
    await owner
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await expect(
      owner.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toHaveAttribute("data-state", "ready");
    await spectator
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await expect(
      spectator.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toHaveAttribute("data-state", "ready");
    // One address convenience request is allowed per installation. It must
    // never upload either phone’s point as dispatcher tracking.
    expect(offShiftRequests).toEqual([]);
    const offlineDetail = await admin.request.get(
      `${api}/admin/drivers/${id}`,
      { headers: adminHeaders },
    );
    expect(await offlineDetail.json()).toMatchObject({
      isOnline: false,
      lastLat: null,
      lastLng: null,
    });
    await owner
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      owner.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await spectator.reload();
    await spectator
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await expect(
      spectator.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toHaveAttribute("data-state", "ready");
    const conflict = await spectator.request.post(`${api}/driver/status`, {
      headers: await headers(spectator, "driver"),
      data: {
        isOnline: true,
        position: { lat: 37.961, lng: 58.321, capturedAt: Date.now() },
      },
    });
    expect(conflict.status()).toBe(409);
    const ownerDetail = await admin.request.get(`${api}/admin/drivers/${id}`, {
      headers: adminHeaders,
    });
    const canonical = await ownerDetail.json();
    expect(Number(canonical.lastLat)).toBe(37.96);
    expect(Number(canonical.lastLng)).toBe(58.32);
    await expect(
      spectator.getByText(
        "Смена активна на другом устройстве. Завершите её там, чтобы выйти на линию здесь.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      spectator.getByRole("button", { name: "Выйти на линию", exact: true }),
    ).toBeDisabled();
    await expect(
      spectator.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toBeEnabled();
    // Releasing the shift unlocks the other signed-in device through live state,
    // without logging either device out or reloading the spectator.
    await owner
      .getByRole("button", { name: "Уйти с линии", exact: true })
      .click();
    await expect(
      spectator.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toBeEnabled();
    await expect(
      spectator.getByText(
        "Смена активна на другом устройстве. Завершите её там, чтобы выйти на линию здесь.",
        { exact: true },
      ),
    ).toHaveCount(0);
    await owner
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      owner.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(
      spectator.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toBeEnabled();
    await spectator.getByRole("link", { name: "Профиль", exact: true }).click();
    await expect(
      spectator.getByText("Устройство и сеанс", { exact: true }),
    ).toHaveCount(0);
    await expect(
      spectator.getByText(
        "Смена работает на другом устройстве. Здесь доступны просмотр и чат. Чтобы работать с этого устройства, сначала завершите смену на другом.",
        { exact: true },
      ),
    ).toBeVisible();
    await spectator.getByRole("link", { name: "Чат", exact: true }).click();
    await expect(spectator).toHaveURL(/driverChat/);
    await spectator.getByRole("link", { name: "Профиль", exact: true }).click();
    await spectator.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(spectator).toHaveURL(/driverLogin/);
    const profile = await owner.request.get(`${api}/driver/profile`, {
      headers: await headers(owner, "driver"),
    });
    expect(profile.ok()).toBe(true);
    expect(await profile.json()).toMatchObject({
      isOnline: true,
      canControlShift: true,
    });
    await owner.reload();
    await expect(owner).toHaveURL(/driverDashboard/);
  } finally {
    await Promise.all([
      adminContext.close(),
      ownerContext.close(),
      spectatorContext.close(),
    ]);
  }
});

test("dispatcher signs out every session without changing the assigned trip or credentials", async ({
  browser,
}) => {
  const adminContext = await browser.newContext();
  const ownerContext = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const spectatorContext = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 37.961, longitude: 58.321, accuracy: 10 },
  });
  const phone = "+99360000742";
  try {
    const admin = await adminContext.newPage();
    const owner = await ownerContext.newPage();
    const spectator = await spectatorContext.newPage();
    await login(admin, "admin", "+99360000000", "admin");
    await expect(admin).toHaveURL(/adminDashboard/);
    const adminHeaders = await headers(admin, "admin");
    const created = await admin.request.post(`${api}/admin/drivers`, {
      headers: adminHeaders,
      data: { fullName: "Sign out all sessions test", phone, password },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    expect(
      (
        await admin.request.post(`${api}/admin/drivers/${id}/balance`, {
          headers: adminHeaders,
          data: {
            operationId: crypto.randomUUID(),
            amount: 100,
            type: "TOPUP",
          },
        })
      ).ok(),
    ).toBe(true);
    await login(owner, "driver", phone, "owner");
    await expect(owner).toHaveURL(/driverDashboard/);
    await login(spectator, "driver", phone, "spectator");
    await expect(spectator).toHaveURL(/driverDashboard/);
    const ownerHeaders = await headers(owner, "driver");
    const spectatorHeaders = await headers(spectator, "driver");
    await owner
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await expect(
      owner.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toHaveAttribute("data-state", "ready");
    await owner
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      owner.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const orderResponse = await admin.request.post(`${api}/admin/orders`, {
      headers: adminHeaders,
      data: {
        districtId: process.env.TEST_REGION_ID,
        clientPhone: "+99365999999",
        priceEstimated: 30,
      },
    });
    expect(orderResponse.status()).toBe(201);
    const order = await orderResponse.json();
    const accepted = await owner.request.post(`${api}/orders/accept`, {
      headers: ownerHeaders,
      data: { orderId: order.id },
    });
    expect(accepted.ok(), await accepted.text()).toBe(true);

    await admin.goto(`/adminDrivers/${id}`);
    await expect(
      admin.getByText("Устройства и входы", { exact: true }),
    ).toHaveCount(0);
    await admin
      .getByRole("button", { name: "Выйти на всех устройствах", exact: true })
      .click();
    const dialog = admin.getByRole("dialog", {
      name: "Выйти на всех устройствах?",
      exact: true,
    });
    await expect(
      dialog.getByText(/Текущая поездка, пароль и баланс сохранятся/),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    expect(
      (
        await owner.request.get(`${api}/driver/profile`, {
          headers: ownerHeaders,
        })
      ).ok(),
    ).toBe(true);
    await admin
      .getByRole("button", { name: "Выйти на всех устройствах", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Выйти на всех устройствах", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    await expect(owner).toHaveURL(/driverLogin/);
    await expect(spectator).toHaveURL(/driverLogin/);
    expect(
      (
        await owner.request.get(`${api}/driver/profile`, {
          headers: ownerHeaders,
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await spectator.request.get(`${api}/driver/profile`, {
          headers: spectatorHeaders,
        })
      ).status(),
    ).toBe(401);
    const detail = await admin.request.get(`${api}/admin/drivers/${id}`, {
      headers: adminHeaders,
    });
    expect(await detail.json()).toMatchObject({
      status: "APPROVED",
      isOnline: false,
      user: { phone },
    });
    const balance = await admin.request.get(`${api}/admin/drivers/${id}`, {
      headers: adminHeaders,
    });
    const funding = (await balance.json()).user.balance;
    expect(Number(funding.amount)).toBe(100);
    expect(Number(funding.held)).toBe(30);
    expect(Number(funding.available)).toBe(70);
    const history = await admin.request.get(
      `${api}/admin/drivers/${id}/history`,
      { headers: adminHeaders },
    );
    expect((await history.json()).orders.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: order.id, status: "ACCEPTED" }),
      ]),
    );
    await login(owner, "driver", phone, "owner");
    await expect(owner).toHaveURL(/driverDashboard/);
    await admin
      .getByRole("button", { name: "Заблокировать", exact: true })
      .click();
    const block = admin.getByRole("dialog", {
      name: "Заблокировать водителя?",
      exact: true,
    });
    await expect(
      block.getByText(/Текущая поездка останется за водителем/),
    ).toBeVisible();
    await expect(
      block.getByRole("button", { name: "Подтвердить", exact: true }),
    ).toBeDisabled();
    await block
      .getByLabel("Причина блокировки")
      .fill("Проверка безопасности аккаунта");
    await block
      .getByRole("button", { name: "Подтвердить", exact: true })
      .click();
    await expect(block).toBeHidden();
    await expect(owner).toHaveURL(/driverLogin/);
    const blockedHistory = await admin.request.get(
      `${api}/admin/drivers/${id}/history`,
      { headers: adminHeaders },
    );
    expect((await blockedHistory.json()).orders.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: order.id, status: "ACCEPTED" }),
      ]),
    );
    await admin
      .getByRole("button", { name: "Разблокировать", exact: true })
      .click();
    await expect(
      admin.getByRole("button", { name: "Заблокировать", exact: true }),
    ).toBeVisible();
    await login(owner, "driver", phone, "owner");
    await expect(owner).toHaveURL(/driverDashboard/);
  } finally {
    await Promise.all([
      adminContext.close(),
      ownerContext.close(),
      spectatorContext.close(),
    ]);
  }
});

test("deleting an account removes access permanently while keeping its history readable", async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    const admin = await context.newPage();
    await login(admin, "admin", "+99360000000", "admin");
    await expect(admin).toHaveURL(/adminDashboard/);
    const adminHeaders = await headers(admin, "admin");
    const phone = "+99360000743";
    const created = await admin.request.post(`${api}/admin/drivers`, {
      headers: adminHeaders,
      data: { fullName: "Deleted account test", phone, password },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    await admin.goto(`/adminDrivers/${id}`);
    await admin
      .getByRole("button", { name: "Удалить аккаунт", exact: true })
      .click();
    const dialog = admin.getByRole("dialog", {
      name: "Удалить аккаунт?",
      exact: true,
    });
    await expect(dialog.getByText(/без восстановления/)).toBeVisible();
    await dialog
      .getByRole("button", { name: "Удалить аккаунт", exact: true })
      .click();
    await expect(admin).toHaveURL(/\/adminDrivers$/);
    await admin.goto(`/adminDrivers/${id}`);
    await expect(
      admin.getByText("Аккаунт удалён", { exact: true }),
    ).toBeVisible();
    for (const label of [
      "Одобрить",
      "Разблокировать",
      "Заблокировать",
      "Сбросить пароль",
      "Выйти на всех устройствах",
      "Сохранить автомобиль",
      "Удалить аккаунт",
    ]) {
      await expect(
        admin.getByRole("button", { name: label, exact: true }),
      ).toHaveCount(0);
    }
    await admin.getByRole("button", { name: "Поездки", exact: true }).click();
    await expect(
      admin.getByText("Поездок пока нет.", { exact: true }),
    ).toBeVisible();
    const loginResponse = await admin.request.post(`${api}/auth/login`, {
      headers: { "X-Forwarded-For": "198.19.0.17" },
      data: { phone, password, deviceId: "deleted-account-phone" },
    });
    expect(loginResponse.status()).toBe(401);
  } finally {
    await context.close();
  }
});
