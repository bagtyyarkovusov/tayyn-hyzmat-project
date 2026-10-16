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

test("approved second device stays logged in without ending or controlling the first device's shift", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const adminContext = await browser.newContext();
  const ownerContext = await browser.newContext({
    permissions: ["geolocation"],
    geolocation: { latitude: 37.96, longitude: 58.32, accuracy: 10 },
  });
  const spectatorContext = await browser.newContext();
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
    const pendingLogin = spectator.waitForResponse(
      (r) => r.url().endsWith("/auth/login") && r.request().method() === "POST",
    );
    await login(spectator, "driver", phone, "spectator");
    expect((await pendingLogin).status()).toBe(403);
    await expect(spectator).toHaveURL(/driverLogin/);
    expect(
      (
        await admin.request.post(`${api}/admin/drivers/${id}/approve-device`, {
          headers: adminHeaders,
        })
      ).ok(),
    ).toBe(true);
    await spectator.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(spectator).toHaveURL(/driverDashboard/);
    await owner.reload();
    await expect(owner).toHaveURL(/driverDashboard/);
    const location = owner.waitForResponse(
      (r) =>
        r.url().endsWith("/driver/location") && r.request().method() === "POST",
    );
    await owner
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    expect((await location).ok()).toBe(true);
    await owner
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      owner.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await spectator.reload();
    await expect(
      spectator.getByText("Смена на другом устройстве", { exact: true }),
    ).toBeVisible();
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
    ).toBeDisabled();
    // Releasing the shift unlocks the other approved device through live state,
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
    ).toBeDisabled();
    await spectator.getByRole("link", { name: "Чат", exact: true }).click();
    await expect(spectator).toHaveURL(/driverChat/);
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
