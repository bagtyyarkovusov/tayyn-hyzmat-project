import { test, expect } from "@playwright/test";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");

for (const width of [390, 1280]) {
  for (const path of ["/driverLogin", "/driverRegister"]) {
    for (const suffix of ["", "/"]) {
      test(`${path}${suffix} has a standalone auth shell at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${path}${suffix}`);
        await expect(
          page.getByLabel("Номер телефона", { exact: true }),
        ).toBeVisible();
        await expect(page.locator(".workspace")).toHaveCount(0);
        await expect(
          page.getByRole("navigation", { name: "Разделы водителя" }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Выйти", exact: true }),
        ).toHaveCount(0);
        await expect(page.locator(".auth-layout")).toHaveCount(1);
        await expect(
          page.getByRole("link", { name: "Tayyn Hyzmat", exact: true }),
        ).toHaveCount(1);
        const dimensions = await page
          .locator(".auth-layout")
          .evaluate((element) => ({
            height: element.getBoundingClientRect().height,
            width: element.getBoundingClientRect().width,
            columns: getComputedStyle(element).gridTemplateColumns,
            display: getComputedStyle(element).display,
          }));
        expect(dimensions.height).toBeGreaterThanOrEqual(844);
        expect(dimensions.width).toBe(width);
        expect(dimensions.display).toBe(width > 760 ? "grid" : "flex");
        if (width > 760) expect(dimensions.columns.split(" ")).toHaveLength(2);
        if (path === "/driverRegister")
          await expect(page.getByLabel("Имя и фамилия")).toBeVisible();
        await expect(page.locator(".phone-prefix")).toHaveText("+993");
      });
    }
  }
}
