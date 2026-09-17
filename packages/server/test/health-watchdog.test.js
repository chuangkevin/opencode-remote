import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  initialHealthWatchdogState,
  nextHealthState,
} from "../dist/health-watchdog.js";

const opts = { failures: 3, restartCooldownMs: 120_000 };

function step(state, probeOk, now = 0) {
  return nextHealthState(state, probeOk, now, opts);
}

test("health watchdog restarts after consecutive failures and success resets the count", () => {
  let state = initialHealthWatchdogState();

  let result = step(state, false);
  assert.equal(result.action, "none");
  assert.equal(result.state.consecutiveFailures, 1);
  state = result.state;

  result = step(state, true);
  assert.equal(result.action, "recovered");
  assert.equal(result.state.consecutiveFailures, 0);
  state = result.state;

  result = step(state, false);
  assert.equal(result.action, "none");
  state = result.state;

  result = step(state, false);
  assert.equal(result.action, "none");
  state = result.state;

  result = step(state, false, 10_000);
  assert.equal(result.action, "restart");
  assert.deepEqual(result.state, {
    consecutiveFailures: 0,
    lastRestartAt: 10_000,
    cooldownWarnedForRestartAt: undefined,
  });
});

test("health watchdog reports cooldown once and restarts after cooldown expires", () => {
  let state = {
    consecutiveFailures: 0,
    lastRestartAt: 10_000,
  };

  let result = step(state, false, 20_000);
  assert.equal(result.action, "none");
  state = result.state;

  result = step(state, false, 40_000);
  assert.equal(result.action, "none");
  state = result.state;

  result = step(state, false, 60_000);
  assert.equal(result.action, "cooldown");
  assert.equal(result.state.cooldownWarnedForRestartAt, 10_000);
  state = result.state;

  result = step(state, false, 80_000);
  assert.equal(result.action, "none");
  assert.equal(result.state.cooldownWarnedForRestartAt, 10_000);
  state = result.state;

  result = step(state, false, 131_000);
  assert.equal(result.action, "restart");
  assert.deepEqual(result.state, {
    consecutiveFailures: 0,
    lastRestartAt: 131_000,
    cooldownWarnedForRestartAt: undefined,
  });
});

test("health watchdog reports recovered when a failure streak succeeds", () => {
  let result = step(initialHealthWatchdogState(), false);
  assert.equal(result.action, "none");

  result = step(result.state, true);
  assert.equal(result.action, "recovered");
  assert.equal(result.state.consecutiveFailures, 0);
});

function readConfigWithEnv(envOverrides = {}) {
  const env = { ...process.env };
  delete env.OPENCODE_HEALTH_WATCHDOG_INTERVAL_MS;
  delete env.OPENCODE_HEALTH_WATCHDOG_TIMEOUT_MS;
  delete env.OPENCODE_HEALTH_WATCHDOG_FAILURES;
  delete env.OPENCODE_HEALTH_WATCHDOG_COOLDOWN_MS;
  Object.assign(env, envOverrides);

  const configUrl = new URL("../dist/config.js", import.meta.url).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { config } from ${JSON.stringify(configUrl)}; console.log(JSON.stringify({ interval: config.healthWatchdogIntervalMs, timeout: config.healthWatchdogTimeoutMs, failures: config.healthWatchdogFailures, cooldown: config.healthWatchdogRestartCooldownMs }));`,
  ], { encoding: "utf8", env });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("config exposes health watchdog defaults and zero disables the interval", () => {
  assert.deepEqual(readConfigWithEnv(), {
    interval: 20_000,
    timeout: 5_000,
    failures: 3,
    cooldown: 120_000,
  });
  assert.deepEqual(readConfigWithEnv({ OPENCODE_HEALTH_WATCHDOG_INTERVAL_MS: "0" }), {
    interval: 0,
    timeout: 5_000,
    failures: 3,
    cooldown: 120_000,
  });
});
