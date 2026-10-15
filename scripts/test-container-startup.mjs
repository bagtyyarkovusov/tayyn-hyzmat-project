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
  const api = `tayyn-api-${id}`;
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
  console.log(
    "Container startup, API proxy, actor/legacy routes and Socket.IO handshake pass.",
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
