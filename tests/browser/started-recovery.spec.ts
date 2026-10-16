import { test, expect } from "@playwright/test";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");
test("dispatcher completes a started drive with a reason and cannot select refund cancellation", async ({
  page,
}) => {
  await page.goto("/adminLogin");
  await page.getByLabel("Номер телефона").fill("60000000");
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.TEST_ACCOUNT_PASSWORD!);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/adminDashboard/);
  const adminToken = await page.evaluate(() =>
    localStorage.getItem("openride.admin.accessToken"),
  );
  const auth = await page.request.post(
    `${process.env.TEST_API_URL}/auth/login`,
    {
      data: {
        phone: "+99360000101",
        password: process.env.TEST_ACCOUNT_PASSWORD,
        deviceId: "synthetic-approved-browser",
      },
    },
  );
  expect(auth.ok()).toBe(true);
  const driverToken = (await auth.json()).accessToken;
  const driverHeaders = { Authorization: `Bearer ${driverToken}` };
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };
  expect(
    (
      await page.request.post(`${process.env.TEST_API_URL}/driver/location`, {
        headers: driverHeaders,
        data: { lat: 37.96, lng: 58.32, capturedAt: Date.now() },
      })
    ).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(`${process.env.TEST_API_URL}/driver/status`, {
        headers: driverHeaders,
        data: { isOnline: true, isAvailable: true },
      })
    ).ok(),
  ).toBe(true);
  const created = await page.request.post(
    `${process.env.TEST_API_URL}/admin/orders`,
    {
      headers: adminHeaders,
      data: {
        districtId: process.env.TEST_REGION_ID,
        clientPhone: "+99365999999",
        priceEstimated: 30,
        pickupAddress: "Проверка начатой поездки",
      },
    },
  );
  expect(created.status()).toBe(201);
  const order = await created.json();
  for (const action of ["accept", "waiting", "start"]) {
    const result = await page.request.post(
      `${process.env.TEST_API_URL}/orders/${action}`,
      { headers: driverHeaders, data: { orderId: order.id } },
    );
    expect(result.status(), await result.text()).toBe(200);
  }
  await page.goto("/adminOrders");
  await page.getByRole("button", { name: "В работе", exact: true }).click();
  const card = page
    .getByRole("article")
    .filter({ hasText: "Проверка начатой поездки" });
  await expect(
    card.getByRole("button", { name: "Отменить заказ", exact: true }),
  ).toHaveCount(0);
  await card
    .getByRole("button", { name: "Завершить вручную", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Завершить поездку вручную?",
    exact: true,
  });
  await expect(dialog.getByText(/возврата нет/)).toBeVisible();
  const confirm = dialog.getByRole("button", {
    name: "Завершить поездку",
    exact: true,
  });
  await expect(confirm).toBeDisabled();
  await dialog
    .getByLabel("Причина")
    .fill("Клиент подтвердил прибытие по телефону");
  await confirm.click();
  await expect(dialog).toBeHidden();
  const history = await page.request.get(
    `${process.env.TEST_API_URL}/driver/history`,
    { headers: driverHeaders },
  );
  const result = await history.json();
  expect(
    result.orders.items.find((item: any) => item.id === order.id).status,
  ).toBe("COMPLETED");
  expect(
    result.transactions.items
      .filter((item: any) => item.orderId === order.id)
      .map((item: any) => item.type),
  ).toEqual(["PAYMENT"]);
  expect(
    (
      await page.request.post(`${process.env.TEST_API_URL}/driver/status`, {
        headers: driverHeaders,
        data: { isOnline: false },
      })
    ).ok(),
  ).toBe(true);
});
