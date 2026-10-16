import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
const id = randomBytes(8).toString("hex");
const network = `tayyn-smoke-${id}`;
const containers = [];
let networkCreated = false;
function docker(...args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 60000,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || "Docker command failed");
  return result.stdout.trim();
}
async function response(url) {
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const result = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (result.ok) return result;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Container endpoint unavailable: ${url}`);
}
try {
  docker("network", "create", network);
  networkCreated = true;
  function startApi(api) {
    docker(
      "run",
      "-d",
      "--name",
      api,
      "--network",
      network,
      "--network-alias",
      "api",
      "-e",
      "DATABASE_URL=postgresql://unused:unused@127.0.0.1:1/unused",
      "-e",
      `JWT_ACCESS_SECRET=${randomBytes(32).toString("hex")}`,
      "-e",
      `JWT_REFRESH_SECRET=${randomBytes(32).toString("hex")}`,
      "tayyn-api-check",
    );
    containers.push(api);
  }
  const api = `tayyn-api-${id}`;
  startApi(api);
  const web = `tayyn-web-${id}`;
  docker(
    "run",
    "-d",
    "--name",
    web,
    "--network",
    network,
    "-p",
    "127.0.0.1::8080",
    "tayyn-web-check",
  );
  containers.push(web);
  const port = docker("port", web, "8080/tcp").split(":").at(-1);
  const base = `http://127.0.0.1:${port}`;
  assert.equal(
    (await (await response(`${base}/api/health`)).json()).status,
    "ok",
  );
  for (const path of [
    "/adminOrders",
    "/driverProfile",
    "/legacy/clientDashboard",
  ]) {
    const html = await (await response(`${base}${path}`)).text();
    assert.match(html, /<html/i);
    assert.match(html, /<script/i);
    assert.match(
      html,
      path.startsWith("/legacy/") ? /\/legacy\/js\// : /\/assets\//,
    );
  }
  const socket = await (
    await response(`${base}/socket.io/?EIO=4&transport=polling`)
  ).text();
  assert.ok(socket.startsWith("0{"), "Nginx forwards the Socket.IO handshake");
  async function checkProxy() {
    assert.equal((await response(`${base}/health`)).status, 200);
    const invalidLogin = await fetch(`${base}/api/auth/login?proxy=checked`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(
      invalidLogin.status,
      400,
      "API prefix, query and POST reach auth validation",
    );
    const socket = new WebSocket(
      `${base.replace("http:", "ws:")}/socket.io/?EIO=4&transport=websocket`,
    );
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("WebSocket handshake timed out"));
      }, 5000);
      socket.addEventListener(
        "message",
        (event) => {
          clearTimeout(timeout);
          try {
            assert.ok(String(event.data).startsWith("0{"));
            socket.close();
            resolve();
          } catch (error) {
            reject(error);
          }
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket upgrade failed"));
        },
        { once: true },
      );
    });
  }
  await checkProxy();
  const replacement = `tayyn-api-replacement-${id}`;
  startApi(replacement);
  const address = (name) =>
    docker(
      "inspect",
      "--format",
      `{{with index .NetworkSettings.Networks "${network}"}}{{.IPAddress}}{{end}}`,
      name,
    );
  assert.notEqual(address(api), address(replacement));
  docker("network", "disconnect", network, api);
  docker("stop", api);
  // The web container must recover without a reload or restart when API DNS changes.
  assert.equal(
    (await (await response(`${base}/api/health`)).json()).status,
    "ok",
  );
  await checkProxy();
  console.log(
    "Container startup, API replacement recovery, routes, POST and Socket.IO polling/WebSocket pass.",
  );
} finally {
  const cleanup = containers.reverse().map((name) => ["rm", "-f", name]);
  if (networkCreated) cleanup.push(["network", "rm", network]);
  for (const args of cleanup) {
    try {
      docker(...args);
    } catch {
      console.error(`Could not remove own smoke resource: ${args.at(-1)}`);
      process.exitCode = 1;
    }
  }
}
