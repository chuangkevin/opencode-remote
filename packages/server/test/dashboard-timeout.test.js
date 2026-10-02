import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";

const serverRoot = path.resolve(new URL("..", import.meta.url).pathname);
const entry = path.join(serverRoot, "dist", "index.js");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startProxy(upstreamUrl, root) {
  const port = await freePort();
  const stateFile = path.join(root, "service.json");
  await writeFile(stateFile, JSON.stringify({ url: upstreamUrl, password: "test" }));
  const cli = path.join(root, "fake-opencode");
  await writeFile(cli, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n");
  await chmod(cli, 0o755);
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      PORT: String(port),
      BIND_ADDRESS: "127.0.0.1",
      OPENCODE_SERVICE_MODE: "1",
      OPENCODE_SERVICE_STATE: stateFile,
      OPENCODE_CLI_PATH: cli,
      OPENCODE_DIRECTORY: root,
      OPENCODE_HEALTH_WATCHDOG_INTERVAL_MS: "0",
      OPENCODE_KEY_DRIFT_INTERVAL_MS: "0",
      DEAD_STREAM_WATCHDOG: "0",
    },
    stdio: "inherit",
  });
  return { child, port };
}

async function waitForProxy(port, maxWaitMs = 4_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      return await fetch(`http://127.0.0.1:${port}/remote-health`, { signal: AbortSignal.timeout(2_500) });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("proxy did not answer /remote-health before deadline");
}

async function stopProxy(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("dashboard endpoints stay available while upstream hangs or is unreachable", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-remote-timeout-"));
  const slowUpstream = http.createServer((req, res) => {
    const timer = setTimeout(() => res.end("late"), 30_000);
    req.on("close", () => clearTimeout(timer));
  });
  const upstreamPort = await listen(slowUpstream);
  const proxy = await startProxy(`http://127.0.0.1:${upstreamPort}`, root);
  t.after(async () => {
    await stopProxy(proxy.child);
    slowUpstream.closeAllConnections();
    await new Promise((resolve) => slowUpstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });

  const healthStart = Date.now();
  const health = await waitForProxy(proxy.port);
  assert.equal(health.status, 502);
  assert.ok(Date.now() - healthStart < 4_000);

  const pairsStart = Date.now();
  const pairs = await fetch(`http://127.0.0.1:${proxy.port}/api/pairs`, { signal: AbortSignal.timeout(3_000) });
  assert.equal(pairs.status, 200);
  assert.equal(pairs.headers.get("x-opencode-remote-degraded"), "true");
  assert.ok(Array.isArray(await pairs.json()));
  assert.ok(Date.now() - pairsStart < 3_000);

  const unreachableProxy = await startProxy("http://127.0.0.1:1", root);
  t.after(() => stopProxy(unreachableProxy.child));
  const unavailableHealth = await waitForProxy(unreachableProxy.port);
  assert.equal(unavailableHealth.status, 502);
});
