import { test, expect } from "@playwright/test";
if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use disposable browser runner");
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 568, height: 320 },
]) {
  test(`dispatcher can select optional map pins and submit without changing region at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      class MapStub {
        geoObjects = { add() {}, remove() {} };
        events: { add: (name: string, callback: (event: any) => void) => void };
        constructor(node: HTMLElement) {
          node.style.background = "#e9ede9";
          this.events = {
            add: (_name, callback) => {
              const pick = document.createElement("button");
              pick.type = "button";
              pick.textContent = "Выбрать точку карты";
              pick.setAttribute("aria-label", "Synthetic map point");
              pick.style.cssText =
                "margin:40px;padding:16px;border:1px solid #777;background:white;border-radius:8px;color:black";
              pick.onclick = () => callback({ get: () => [37.97, 58.34] });
              node.append(pick);
            },
          };
        }
        destroy() {}
      }
      class Marker {
        geometry = { setCoordinates() {} };
      }
      (window as any).ymaps = {
        ready: (callback: () => void) => callback(),
        Map: MapStub,
        Placemark: Marker,
      };
    });
    await page.goto("/adminLogin");
    await page.getByLabel("Номер телефона").fill("60000000");
    await page
      .getByLabel("Пароль", { exact: true })
      .fill(process.env.TEST_ACCOUNT_PASSWORD!);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(/adminDashboard/);
    await page.goto("/adminOrders?create=1");
    const dialog = page.getByRole("dialog", {
      name: "Новый заказ",
      exact: true,
    });
    await expect(dialog).toBeVisible();
    const region = dialog.getByLabel("Район", { exact: true });
    await region.selectOption(process.env.TEST_REGION_ID!);
    await dialog.getByLabel("Телефон клиента").fill("65999999");
    await dialog.getByLabel("Стоимость, TMT").fill("25");
    const map = dialog.getByLabel("Карта уточнения точки подачи", {
      exact: true,
    });
    await map.scrollIntoViewIfNeeded();
    const box = await map.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(190);
    if (viewport.width >= 900) {
      const field = await region.boundingBox();
      expect(box!.width).toBeGreaterThan(500);
      expect(box!.x).toBeGreaterThan(field!.x + field!.width);
      expect(box!.height).toBeGreaterThanOrEqual(400);
    }
    await dialog.getByRole("button", { name: "Synthetic map point" }).click();
    await expect(
      dialog.getByText("Точка подачи выбрана", { exact: false }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Куда", exact: true }).click();
    await dialog.getByRole("button", { name: "Synthetic map point" }).click();
    await expect(region).toHaveValue(process.env.TEST_REGION_ID!);
    const dimensions = await dialog.evaluate((node) => ({
      scroll: node.scrollWidth,
      width: node.clientWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    await expect(close).toHaveCSS("border-top-width", "0px");
    await page.screenshot({
      path: test.info().outputPath("optional-map-layout.png"),
      fullPage: true,
    });
    const submit = dialog.getByRole("button", {
      name: "Отправить водителям",
      exact: true,
    });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/admin/orders") && r.request().method() === "POST",
    );
    await submit.click();
    const createdResponse = await response;
    expect(createdResponse.status()).toBe(201);
    const order = await createdResponse.json();
    expect(order.districtId).toBe(process.env.TEST_REGION_ID);
    expect(Number(order.pickupLat)).toBe(37.97);
    expect(Number(order.dropoffLng)).toBe(58.34);
    expect(order.priceEstimated).toBe("25");
    await expect(dialog).toBeHidden();
    const token = await page.evaluate(() =>
      localStorage.getItem("openride.admin.accessToken"),
    );
    expect(
      (
        await page.request.post(
          `${process.env.TEST_API_URL}/admin/orders/${order.id}/cancel`,
          { headers: { Authorization: `Bearer ${token}` }, data: {} },
        )
      ).ok(),
    ).toBe(true);
  });
}
