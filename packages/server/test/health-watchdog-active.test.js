import assert from "node:assert/strict";
import test from "node:test";

import {
  initialHealthWatchdogState,
  evaluateHealthRecovery,
  healthRecoveryPolicy,
  nextHealthState,
  shouldDeferHealthRecovery,
  startHealthRecoveryDeferral,
} from "../dist/health-watchdog.js";

test("complete recovery transition keeps one monotonic grace across failed ticks and wall-clock rollback", () => {
  const opts = { failures: 1, restartCooldownMs: 0 };
  let state = { consecutiveFailures: 0 };
  const steps = [0, 60_000, 120_000, 179_999].map((monotonicNow, index) => {
    const result = evaluateHealthRecovery({
      state,
      probeOk: false,
      wallNow: index === 0 ? 100_000 : 100_000 - index * 20_000,
      monotonicNow,
      options: opts,
      activityStatus: "busy",
      activePrompts: 1,
      ownedChildExited: false,
    });
    state = result.state;
    return result;
  });
  assert.ok(steps.every((step) => step.action === "deferred"));
  assert.equal(state.recoveryDeferredAt, 0);
  assert.equal(state.lastRestartAt, undefined);

  const expired = evaluateHealthRecovery({
    state,
    probeOk: false,
    wallNow: 10_000,
    monotonicNow: 180_000,
    options: opts,
    activityStatus: "busy",
    activePrompts: 1,
    ownedChildExited: false,
  });
  assert.equal(expired.action, "restart");
  assert.equal(expired.state.lastRestartAt, 10_000);
  assert.equal("recoveryDeferredAt" in expired.state, false);
});

test("healthy recovery, exited child and verified idle bypass grace; busy status after early response defers", () => {
  const opts = { failures: 1, restartCooldownMs: 0 };
  const state = { consecutiveFailures: 2, lastRestartAt: 5, recoveryDeferredAt: 1_000 };
  assert.equal(evaluateHealthRecovery({ state, probeOk: true, wallNow: 2_000, monotonicNow: 2_000, options: opts, activityStatus: "idle", activePrompts: 0, ownedChildExited: false }).state.recoveryDeferredAt, undefined);
  assert.equal(evaluateHealthRecovery({ state, probeOk: false, wallNow: 2_000, monotonicNow: 2_000, options: opts, activityStatus: "busy", activePrompts: 0, ownedChildExited: true }).action, "restart");
  assert.equal(evaluateHealthRecovery({ state, probeOk: false, wallNow: 2_000, monotonicNow: 2_000, options: opts, activityStatus: "idle", activePrompts: 0, ownedChildExited: false }).action, "restart");
  assert.equal(evaluateHealthRecovery({ state, probeOk: false, wallNow: 2_000, monotonicNow: 2_000, options: opts, activityStatus: "unknown", activePrompts: 0, ownedChildExited: false }).action, "deferred");
});

test("recovery policy gates lookup and deferral to managed mode and exact owned-child exit", () => {
  const opts = { failures: 1, restartCooldownMs: 0 };
  const common = {
    state: { consecutiveFailures: 0 }, probeOk: false, wallNow: 10_000, monotonicNow: 10_000,
    options: opts, activityStatus: "busy", activePrompts: 1, ownedChildExited: false,
  };
  assert.deepEqual(healthRecoveryPolicy({ managed: false, ownsOpenCodeProcess: true, ownedChildExited: false }), {
    lookupActivity: false, deferRecovery: false, effectiveOwnedChildExited: false,
  });
  assert.equal(evaluateHealthRecovery({ ...common, managed: false, ownsOpenCodeProcess: true }).action, "restart");
  assert.equal(healthRecoveryPolicy({ managed: true, ownsOpenCodeProcess: false, ownedChildExited: true }).effectiveOwnedChildExited, false);
  assert.equal(evaluateHealthRecovery({ ...common, managed: true, ownsOpenCodeProcess: false, ownedChildExited: true }).action, "deferred");
  assert.equal(healthRecoveryPolicy({ managed: true, ownsOpenCodeProcess: true, ownedChildExited: true }).lookupActivity, false);
  assert.equal(evaluateHealthRecovery({ ...common, managed: true, ownsOpenCodeProcess: true, ownedChildExited: true }).action, "restart");
});

test("active generation defers unhealthy recovery for a bounded grace from first failure", () => {
  let state = initialHealthWatchdogState();
  const opts = { failures: 1, restartCooldownMs: 0 };
  const first = nextHealthState(state, false, 10_000, opts);
  assert.equal(first.action, "restart");
  state = startHealthRecoveryDeferral(first.state, 10_000);

  assert.equal(shouldDeferHealthRecovery({ state, now: 10_001, activePrompts: 1, status: "unknown" }), true);
  assert.equal(shouldDeferHealthRecovery({ state, now: 190_001, activePrompts: 1, status: "unknown" }), false);
  assert.equal(shouldDeferHealthRecovery({ state, now: 10_002, activePrompts: 0, status: "idle" }), false);
  assert.equal(shouldDeferHealthRecovery({ state, now: 10_002, activePrompts: 0, status: "unknown" }), true);

  const recovered = nextHealthState(state, true, 20_000, opts);
  assert.equal(recovered.state.recoveryDeferredAt, undefined);
});

test("legacy state shape is preserved and deferral does not renew its deadline", () => {
  const opts = { failures: 4, restartCooldownMs: 60_000 };
  const legacy = { consecutiveFailures: 2, lastRestartAt: 1_000 };
  const next = nextHealthState(legacy, false, 2_000, opts);
  assert.deepEqual(next.state, { consecutiveFailures: 3, lastRestartAt: 1_000 });

  let deferred = startHealthRecoveryDeferral(next.state, 50_000);
  deferred = startHealthRecoveryDeferral(deferred, 200_000);
  assert.equal(deferred.recoveryDeferredAt, 50_000);
  assert.equal(shouldDeferHealthRecovery({ state: deferred, now: 229_999, activePrompts: 1, status: "busy" }), true);
  assert.equal(shouldDeferHealthRecovery({ state: deferred, now: 230_000, activePrompts: 1, status: "busy" }), false);
  assert.equal(nextHealthState(deferred, true, 231_000, opts).state.recoveryDeferredAt, undefined);
});
