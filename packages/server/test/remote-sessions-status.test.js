import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bindStatusPollerLifecycle,
  busySessionIds,
  createStatusPoller,
  loadSessionStatuses,
} from "../static/remote-sessions.js";

test("classifies only busy sessions as running", () => {
  assert.deepEqual(busySessionIds({
    ses_busy: { type: "busy" },
    ses_idle: { type: "idle" },
    ses_retry: { type: "retry" },
    ses_unknown: { type: "something-else" },
    ses_missing: {},
  }), ["ses_busy"]);
});

test("failed status polls preserve stale state and do not overlap", async () => {
  let resolveFirst;
  let calls = 0;
  const applied = [];
  const poller = createStatusPoller({
    load: async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      throw new Error("offline");
    },
    apply: (statuses) => applied.push(statuses),
  });

  const first = poller.poll();
  assert.equal(await poller.poll(), false);
  assert.equal(calls, 1);

  resolveFirst({ ses_busy: { type: "busy" } });
  assert.equal(await first, true);
  assert.deepEqual(applied, [{ ses_busy: { type: "busy" } }]);

  assert.equal(await poller.poll(), false);
  assert.equal(calls, 2);
  assert.deepEqual(applied, [{ ses_busy: { type: "busy" } }]);
});

test("loads and merges statuses once per encoded session directory", async () => {
  const requests = [];
  const signal = AbortSignal.timeout(1_000);
  const statuses = await loadSessionStatuses(
    ["/workspace/one", "/workspace/space & 二", "/workspace/one"],
    signal,
    async (url, options) => {
      requests.push({ url, signal: options.signal });
      return Response.json({
        [`ses_${requests.length}`]: { type: "busy" },
      });
    },
  );

  assert.deepEqual(requests.map(({ url }) => url), [
    "/session/status?directory=%2Fworkspace%2Fone",
    "/session/status?directory=%2Fworkspace%2Fspace%20%26%20%E4%BA%8C",
  ]);
  assert.ok(requests.every((request) => request.signal === signal));
  assert.deepEqual(statuses, {
    ses_1: { type: "busy" },
    ses_2: { type: "busy" },
  });
});

test("loads at most four session directories concurrently", async () => {
  const directories = Array.from({ length: 9 }, (_, index) => `/workspace/${index}`);
  const releases = [];
  let started = 0;
  let active = 0;
  let maxActive = 0;
  const pending = loadSessionStatuses(directories, AbortSignal.timeout(1_000), async () => {
    started += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
    return Response.json({});
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maxActive, 4);
  assert.equal(active, 4);

  while (started < directories.length) {
    releases.shift()();
    await new Promise((resolve) => setImmediate(resolve));
  }
  while (releases.length > 0) releases.shift()();

  await pending;
  assert.ok(maxActive <= 4);
});

test("stops a fulfilled poll before its result can update state", async () => {
  let resolveLoad;
  const applied = [];
  const poller = createStatusPoller({
    load: () => new Promise((resolve) => {
      resolveLoad = resolve;
    }),
    apply: (statuses) => applied.push(statuses),
  });

  const pending = poller.poll();
  resolveLoad({ ses_busy: { type: "busy" } });
  poller.stop();

  assert.equal(await pending, false);
  assert.deepEqual(applied, []);
});

test("starts immediately, repeats every five seconds, and aborts after three seconds", async () => {
  let calls = 0;
  let intervalDelay;
  let timeoutDelay;
  let abortRequest;
  let requestSignal;
  const poller = createStatusPoller({
    load: (signal) => {
      calls += 1;
      requestSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    apply: () => assert.fail("an aborted request must not update state"),
    setIntervalFn: (_callback, delay) => {
      intervalDelay = delay;
      return 1;
    },
    clearIntervalFn: () => {},
    setTimeoutFn: (callback, delay) => {
      timeoutDelay = delay;
      abortRequest = callback;
      return 2;
    },
    clearTimeoutFn: () => {},
  });

  poller.start();
  assert.equal(calls, 1);
  assert.equal(intervalDelay, 5_000);
  assert.equal(timeoutDelay, 3_000);

  abortRequest();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestSignal.aborted, true);
  poller.stop();
});

test("pauses status polling while hidden and polls immediately when visible", () => {
  const listeners = new Map();
  const calls = [];
  const documentTarget = {
    visibilityState: "visible",
    addEventListener: (name, listener) => listeners.set(`document:${name}`, listener),
  };
  const windowTarget = {
    addEventListener: (name, listener) => listeners.set(`window:${name}`, listener),
  };
  const poller = {
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
  };

  bindStatusPollerLifecycle(poller, documentTarget, windowTarget);
  assert.deepEqual(calls, ["start"]);

  documentTarget.visibilityState = "hidden";
  listeners.get("document:visibilitychange")();
  documentTarget.visibilityState = "visible";
  listeners.get("document:visibilitychange")();
  listeners.get("window:pagehide")();
  listeners.get("window:pageshow")();

  assert.deepEqual(calls, ["start", "stop", "start", "stop", "start"]);
});

test("remote sessions HTML wires an accessible reduced-motion-safe indicator", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

  assert.match(source, /class="running-indicator"[^>]*hidden[^>]*title="執行中"[^>]*aria-label="執行中"/);
  assert.match(source, /data-session-directory="\$\{escapeHtml\(session\.directory\)\}"/);
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(source, /<script type="module" src="\/c\/static\/remote-sessions\.js"><\/script>/);

  const client = await readFile(new URL("../static/remote-sessions.js", import.meta.url), "utf8");
  assert.match(client, /addEventListener\("visibilitychange", handleVisibilityChange\)/);
  assert.match(client, /addEventListener\("pagehide", handlePageHide\)/);
  assert.match(client, /addEventListener\("pageshow", handlePageShow\)/);
});
