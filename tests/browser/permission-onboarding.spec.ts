import { test, expect, type BrowserContext, type Page } from "@playwright/test";

if (process.env.DISPOSABLE_BROWSER_TEST !== "true")
  throw new Error("Use pnpm test:e2e with its disposable database");

async function nativePermissions(context: BrowserContext) {
  await context.addInitScript(() => {
    const bridge = window as any;
    bridge.CapacitorCustomPlatform = { name: "android" };
    const methods = (names: string[]) =>
      names.map((name) => ({ name, rtype: "promise" }));
    const locationStatus = () => ({
      running: localStorage.getItem("os.running") === "true",
      userId:
        JSON.parse(localStorage.getItem("tayyn.driver.user") || "null")?.id ||
        "",
      phase: localStorage.getItem("os.running") === "true" ? "online" : "off",
      detail: "",
      lastReportAt:
        localStorage.getItem("os.running") === "true" ? Date.now() : 0,
      lastFixAt: Number(localStorage.getItem("os.fixAt")),
      stopSequence: 0,
      lat: 37.96,
      lng: 58.32,
      accuracy: 10,
      locationGranted: localStorage.getItem("os.location") === "granted",
      locationPermission: localStorage.getItem("os.location") || "prompt",
      locationEnabled: true,
    });
    const notificationStatus = () => ({
      permission: localStorage.getItem("os.notifications") || "prompt",
      enabled: true,
      configured: false,
    });
    const prompt = (kind: "location" | "notifications") =>
      new Promise((resolve, reject) => {
        const dialog = document.createElement("div");
        dialog.role = "dialog";
        dialog.setAttribute(
          "aria-label",
          kind === "location"
            ? "Android precise location permission"
            : "Android notification permission",
        );
        dialog.style.cssText =
          "position:fixed;bottom:90px;left:20px;z-index:9999;background:white;color:black;padding:30px";
        for (const choice of ["Allow", "Deny", "Dismiss"]) {
          const button = document.createElement("button");
          button.textContent = choice;
          button.onclick = () => {
            dialog.remove();
            localStorage.setItem(
              `os.${kind}`,
              choice === "Allow"
                ? "granted"
                : choice === "Dismiss"
                  ? "prompt"
                  : "denied",
            );
            if (choice === "Dismiss") reject(new Error("Permission dismissed"));
            else
              resolve(
                kind === "location" ? locationStatus() : notificationStatus(),
              );
          };
          dialog.append(button);
        }
        document.body.append(dialog);
      });
    bridge.Capacitor = {
      PluginHeaders: [
        {
          name: "DriverShift",
          methods: methods([
            "permissions",
            "status",
            "location",
            "stop",
            "clear",
            "notificationTarget",
            "start",
          ]),
        },
        {
          name: "DriverNotifications",
          methods: [
            ...methods([
              "status",
              "requestPermissions",
              "configure",
              "setEnabled",
              "setPresence",
              "deliver",
              "clear",
              "reset",
              "settings",
              "removeListener",
            ]),
            { name: "addListener", rtype: "callback" },
          ],
        },
      ],
      nativeCallback: () => "permission-listener",
      nativePromise: async (plugin: string, method: string) => {
        if (plugin === "DriverShift") {
          if (method === "permissions")
            return localStorage.getItem("os.location") === "granted"
              ? locationStatus()
              : prompt("location");
          if (method === "location") {
            localStorage.setItem("os.fixAt", String(Date.now()));
            return {
              lat: 37.96,
              lng: 58.32,
              accuracy: 10,
              timestamp: Date.now(),
            };
          }
          if (method === "start") localStorage.setItem("os.running", "true");
          if (method === "stop") localStorage.setItem("os.running", "false");
          if (method === "status") return locationStatus();
        }
        if (plugin === "DriverNotifications") {
          if (method === "requestPermissions") return prompt("notifications");
          if (method === "status") return notificationStatus();
        }
        return {};
      },
    };
  });
}
async function login(page: Page, phone = "60000101") {
  await page.getByLabel("Номер телефона").fill(phone);
  await page
    .getByLabel("Пароль", { exact: true })
    .fill(process.env.TEST_ACCOUNT_PASSWORD!);
  await page.getByRole("button", { name: "Войти", exact: true }).click();
  await expect(page).toHaveURL(/driverDashboard/);
}

test("APK asks precise location then notifications after driver login without starting a shift", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await nativePermissions(context);
  const page = await context.newPage();
  const workRequests: string[] = [];
  page.on("request", (request) => {
    if (
      /\/driver\/(status|location|shift|address)/.test(
        new URL(request.url()).pathname,
      )
    )
      workRequests.push(request.url());
  });
  try {
    await page.goto("/driverLogin");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await login(page);
    const location = page.getByRole("dialog", {
      name: "Android precise location permission",
    });
    await expect(location).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Android notification permission" }),
    ).toHaveCount(0);
    await location.getByRole("button", { name: "Allow", exact: true }).click();
    const notifications = page.getByRole("dialog", {
      name: "Android notification permission",
    });
    await expect(notifications).toBeVisible();
    await notifications
      .getByRole("button", { name: "Allow", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Выйти на линию", exact: true }),
    ).toBeVisible();
    expect(workRequests).toEqual([]);
    await page.reload();
    await expect(
      page.getByRole("navigation", { name: "Разделы водителя" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

for (const choice of ["Deny", "Dismiss"]) {
  test(`location ${choice.toLowerCase()} still offers notifications and never repeats automatically`, async ({
    browser,
  }) => {
    const context = await browser.newContext();
    await nativePermissions(context);
    const page = await context.newPage();
    try {
      await page.goto("/driverLogin");
      await login(page);
      await page
        .getByRole("dialog", { name: "Android precise location permission" })
        .getByRole("button", { name: choice, exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Android notification permission" })
        .getByRole("button", { name: "Deny", exact: true })
        .click();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(
        page.getByRole("button", { name: "Включить GPS", exact: true }),
      ).toHaveAttribute("data-state", "blocked");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: "Выйти", exact: true }).click();
      await login(page);
      await expect(
        page.getByRole("navigation", { name: "Разделы водителя" }),
      ).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.reload();
      await expect(
        page.getByRole("navigation", { name: "Разделы водителя" }),
      ).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
}

test("an unfinished location prompt cannot request notifications after logout", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await nativePermissions(context);
  const page = await context.newPage();
  try {
    await page.goto("/driverLogin");
    await login(page);
    const location = page.getByRole("dialog", {
      name: "Android precise location permission",
    });
    await expect(location).toBeVisible();
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await expect(page).toHaveURL(/driverLogin/);
    await location.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Войти", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // A later verified login may finish the installation's remaining permission.
    await login(page);
    await expect(
      page.getByRole("dialog", { name: "Android notification permission" }),
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Android precise location permission" }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("notification denial does not prevent a deliberate shift with precise GPS", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await nativePermissions(context);
  const page = await context.newPage();
  try {
    await page.goto("/driverLogin");
    await login(page);
    await page
      .getByRole("dialog", { name: "Android precise location permission" })
      .getByRole("button", { name: "Allow", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Android notification permission" })
      .getByRole("button", { name: "Deny", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Включить GPS", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Включить GPS", exact: true }),
    ).toHaveAttribute("data-state", "ready");
    await page
      .getByRole("button", { name: "Выйти на линию", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Уйти с линии", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Уйти с линии", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Выйти на линию", exact: true }),
    ).toBeVisible();
  } finally {
    if (await page.getByRole("button", { name: "Выйти", exact: true }).count())
      await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await context.close();
  }
});

test("admin login and failed driver login never request APK permissions", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await nativePermissions(context);
  const page = await context.newPage();
  try {
    await page.goto("/driverLogin");
    await page.getByLabel("Номер телефона").fill("60000101");
    await page.getByLabel("Пароль", { exact: true }).fill("WrongPassword123");
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goto("/adminLogin");
    await page.getByLabel("Номер телефона").fill("60000000");
    await page
      .getByLabel("Пароль", { exact: true })
      .fill(process.env.TEST_ACCOUNT_PASSWORD!);
    await page.getByRole("button", { name: "Войти", exact: true }).click();
    await expect(page).toHaveURL(/adminDashboard/);
    await expect(page.getByRole("heading", { name: "Обзор" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("browser driver login keeps permission requests behind manual controls", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Notification.requestPermission = async () => {
      throw new Error("Automatic browser permission request");
    };
    navigator.geolocation.getCurrentPosition = () => {
      throw new Error("Automatic browser location request");
    };
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/driverLogin");
  await login(page);
  await expect(
    page.getByRole("button", { name: "Включить GPS", exact: true }),
  ).toHaveAttribute("data-state", "inactive");
  expect(errors).toEqual([]);
});

test("dismissed notification permission is not requested again after reload", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await nativePermissions(context);
  const page = await context.newPage();
  try {
    await page.goto("/driverLogin");
    await login(page);
    await page
      .getByRole("dialog", { name: "Android precise location permission" })
      .getByRole("button", { name: "Allow", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Android notification permission" })
      .getByRole("button", { name: "Dismiss", exact: true })
      .click();
    await page.reload();
    await expect(
      page.getByRole("navigation", { name: "Разделы водителя" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("switching accounts during location permission keeps the next prompt in the verified replacement session", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await nativePermissions(context);
  const page = await context.newPage();
  try {
    await page.goto("/driverLogin");
    await login(page);
    const location = page.getByRole("dialog", {
      name: "Android precise location permission",
    });
    await expect(location).toBeVisible();
    await page.getByRole("button", { name: "Выйти", exact: true }).click();
    await login(page, "60000102");
    await expect(
      page.getByRole("dialog", { name: "Android notification permission" }),
    ).toHaveCount(0);
    await location.getByRole("button", { name: "Allow", exact: true }).click();
    const notifications = page.getByRole("dialog", {
      name: "Android notification permission",
    });
    await expect(notifications).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await notifications
      .getByRole("button", { name: "Deny", exact: true })
      .click();
    await page.getByRole("link", { name: "Профиль", exact: true }).click();
    await expect(
      page.getByText("Второй водитель", { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
