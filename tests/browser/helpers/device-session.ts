import {
  expect,
  type APIRequestContext,
  type BrowserContext,
} from "@playwright/test";

let nextAuthClient = 1;
let nextBrowserClient = 1;
const browserClients = new WeakMap<BrowserContext, string>();
/** The loopback proxy must not merge unrelated browsers into one auth bucket. */
export async function isolateBrowserClient(context: BrowserContext) {
  if (browserClients.has(context)) return;
  const address = `198.21.${process.pid % 200}.${nextBrowserClient++}`;
  browserClients.set(context, address);
  await context.setExtraHTTPHeaders({ "X-Forwarded-For": address });
}
/** Real auth sessions retain the same signed device identity through refresh and reload. */
export async function loginFixture(
  request: APIRequestContext,
  phone: string,
  deviceId = "synthetic-approved-browser",
) {
  const response = await request.post(
    `${process.env.TEST_API_URL}/auth/login`,
    {
      headers: {
        "X-Forwarded-For": `198.20.${process.pid % 200}.${nextAuthClient++}`,
      },
      data: {
        phone,
        password: process.env.TEST_ACCOUNT_PASSWORD,
        deviceId,
        deviceLabel: "Disposable browser fixture",
      },
    },
  );
  expect(response.ok(), `Fixture login failed (${response.status()})`).toBe(
    true,
  );
  return response.json();
}
export async function installFixtureSession(
  context: BrowserContext,
  role: "admin" | "driver",
  session: { accessToken: string; refreshToken: string; user: object },
  deviceId = "synthetic-approved-browser",
) {
  await context.addInitScript(
    ({ role, session, deviceId }) => {
      localStorage.setItem(`openride.${role}.accessToken`, session.accessToken);
      localStorage.setItem(
        `openride.${role}.refreshToken`,
        session.refreshToken,
      );
      localStorage.setItem(`tayyn.${role}.user`, JSON.stringify(session.user));
      if (role === "driver")
        localStorage.setItem("openride.driver.deviceId", deviceId);
    },
    { role, session, deviceId },
  );
}
