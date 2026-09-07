import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HEARTBEAT_INTERVAL_MS,
  initializeDesktopBridge,
  isLoopbackServerUrl,
  scheduleDesktopConnectionHeartbeat,
  writeDesktopConnection,
} from "../../../deploy/opencode-remote/opencode-remote-desktop-bridge-lib.js";

test("global Desktop bridge plugin exposes exactly one function export", async () => {
  const plugin = await import("../../../deploy/macos/opencode-remote-desktop-bridge.js");

  assert.deepEqual(Object.keys(plugin), ["OpenCodeRemoteDesktopBridge"]);
  assert.equal(typeof plugin.OpenCodeRemoteDesktopBridge, "function");
});

test("desktop bridge accepts only HTTP loopback server URLs", () => {
  for (const url of [
    "http://localhost:1234",
    "https://localhost:4321/",
    "http://127.0.0.1:1234",
    "http://127.42.0.9:1234",
    "http://[::1]:1234",
  ]) {
    assert.equal(isLoopbackServerUrl(url), true, url);
  }

  for (const url of [
    "ftp://127.0.0.1:1234",
    "http://localhost.example.com:1234",
    "http://0.0.0.0:1234",
    "http://192.168.1.10:1234",
    "https://example.com",
    "not a URL",
  ]) {
    assert.equal(isLoopbackServerUrl(url), false, url);
  }
});

test("desktop bridge atomically writes private runtime credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-remote-bridge-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
  const filePath = join(root, "runtime", "desktop-connection.json");
  const connection = {
    origin: "http://127.0.0.1:54321",
    username: "desktop-user",
    password: "desktop-secret",
    pid: process.pid,
    updatedAt: Date.now(),
  };

  assert.equal(await writeDesktopConnection(connection, filePath), undefined);

  const [directoryInfo, fileInfo, body, entries] = await Promise.all([
    stat(join(root, "runtime")),
    stat(filePath),
    readFile(filePath, "utf8"),
    readdir(join(root, "runtime")),
  ]);
  assert.equal(directoryInfo.mode & 0o777, 0o700);
  assert.equal(fileInfo.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(body), connection);
  assert.deepEqual(entries, ["desktop-connection.json"]);
});

test("desktop bridge schedules one unrefed five-minute heartbeat and refreshes updatedAt", async () => {
  const globalObject = {};
  const writes = [];
  const timers = [];
  const connection = {
    origin: "http://127.0.0.1:54321",
    username: "desktop-user",
    password: "desktop-secret",
    pid: 123,
    updatedAt: 100,
  };
  const options = {
    globalObject,
    nowFn: () => 200,
    writeFn: async (value) => writes.push(value),
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, unrefCalls: 0, unref() { this.unrefCalls += 1; } };
      timers.push(timer);
      return timer;
    },
  };

  scheduleDesktopConnectionHeartbeat(connection, options);
  scheduleDesktopConnectionHeartbeat({ ...connection, origin: "http://127.0.0.1:54322" }, options);

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, HEARTBEAT_INTERVAL_MS);
  assert.equal(timers[0].unrefCalls, 1);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, [{ ...connection, origin: "http://127.0.0.1:54322", updatedAt: 200 }]);
});

test("desktop bridge heartbeat ignores runtime write failures", async () => {
  let callback;
  scheduleDesktopConnectionHeartbeat(
    {
      origin: "http://127.0.0.1:54321",
      username: "desktop-user",
      password: "desktop-secret",
      pid: 123,
      updatedAt: 100,
    },
    {
      globalObject: {},
      writeFn: () => { throw new Error("disk unavailable"); },
      setIntervalFn: (value) => {
        callback = value;
        return {};
      },
    },
  );

  assert.doesNotThrow(() => callback());
  await new Promise((resolve) => setImmediate(resolve));
});

test("desktop bridge initialization is best-effort when runtime writes fail", async () => {
  let scheduled = 0;
  const result = await initializeDesktopBridge(
    { serverUrl: "http://127.0.0.1:54321" },
    {
      env: {
        OPENCODE_CLIENT: "desktop",
        OPENCODE_SERVER_USERNAME: "desktop-user",
        OPENCODE_SERVER_PASSWORD: "desktop-secret",
      },
      pid: 123,
      nowFn: () => 456,
      writeFn: async () => { throw new Error("disk unavailable"); },
      scheduleFn: () => { scheduled += 1; },
    },
  );

  assert.deepEqual(result, {});
  assert.equal(scheduled, 1);
});
