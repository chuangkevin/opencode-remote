import assert from "node:assert/strict";
import test from "node:test";

import { emitHealthLifecycleDiagnostic, formatHealthLifecycleDiagnostic, evaluateHealthRecovery, signalChildWithHealthDiagnostic } from "../dist/health-watchdog.js";

const base = {
  timestamp: "2026-10-01T12:34:56.789Z",
  ownership: "owned",
  action: "probe",
  reason: "probe-result",
  pid: 42,
  probe: "unhealthy",
  consecutiveFailures: 2,
  activePrompts: 1,
  graceRemainingMs: 179_000,
};

test("diagnostic formatter emits stable timestamp and complete typed fields", () => {
  const line = formatHealthLifecycleDiagnostic(base);
  assert.ok(line.startsWith("[opencode-remote] health-watchdog "));
  const event = JSON.parse(line.slice(line.indexOf("{")));
  assert.deepEqual(event, {
    timestamp: "2026-10-01T12:34:56.789Z", ownership: "owned", action: "probe", reason: "probe-result",
    pid: 42, probe: "unhealthy", consecutiveFailures: 2, activePrompts: 1, graceRemainingMs: 179_000,
  });
  for (const field of ["timestamp", "ownership", "action", "reason", "probe", "consecutiveFailures", "activePrompts", "graceRemainingMs"])
    assert.ok(Object.hasOwn(event, field), field);
});

test("formatter omits unknown PIDs, clamps invalid metadata, and rejects arbitrary reason strings", () => {
  for (const ownership of ["owned", "shared"]) {
    const event = JSON.parse(formatHealthLifecycleDiagnostic({ ...base, ownership, reason: "Bearer secret-token" }).slice("[opencode-remote] health-watchdog ".length));
    assert.equal(event.ownership, ownership);
    assert.equal(event.pid, 42);
    assert.equal(event.reason, "ownership-unavailable");
    const unknownPid = JSON.parse(formatHealthLifecycleDiagnostic({ ...base, ownership, pid: "ses_private" }).slice("[opencode-remote] health-watchdog ".length));
    assert.equal(Object.hasOwn(unknownPid, "pid"), false);
  }
  const event = JSON.parse(formatHealthLifecycleDiagnostic({ ...base, consecutiveFailures: Infinity, activePrompts: -5, graceRemainingMs: 9_000_000_000, extra: "secret" }).slice("[opencode-remote] health-watchdog ".length));
  assert.equal(event.consecutiveFailures, 0);
  assert.equal(event.activePrompts, 0);
  assert.equal(event.graceRemainingMs, 1_000_000);
  assert.equal(Object.hasOwn(event, "extra"), false);
});

test("secret-bearing extra properties are discarded and throwing logger cannot escape", () => {
  let output = "";
  emitHealthLifecycleDiagnostic({ ...base, body: "body-secret", header: "header-secret", url: "https://host/?token=url-secret", key: "key-secret", token: "token-secret", rawError: "error-secret", sessionID: "ses_private" }, (line) => { output = line; });
  for (const secret of ["body-secret", "header-secret", "url-secret", "key-secret", "token-secret", "error-secret", "ses_private"])
    assert.equal(output.includes(secret), false, secret);
  assert.doesNotThrow(() => emitHealthLifecycleDiagnostic(base, () => { throw new Error("logger-secret"); }));
});

test("actions retain actual outcomes, including active deferral, recovery, and logger isolation", () => {
  const deferred = evaluateHealthRecovery({ state: { consecutiveFailures: 0 }, probeOk: false, wallNow: 10, monotonicNow: 10, options: { failures: 1, restartCooldownMs: 0 }, activityStatus: "busy", activePrompts: 1, ownedChildExited: false });
  assert.equal(deferred.action, "deferred");
  const recovered = evaluateHealthRecovery({ state: deferred.state, probeOk: true, wallNow: 20, monotonicNow: 20, options: { failures: 1, restartCooldownMs: 0 }, activityStatus: "idle", activePrompts: 0, ownedChildExited: false });
  assert.equal(recovered.action, "recovered");
  assert.equal(recovered.state.consecutiveFailures, 0);
  const emitted = [];
  emitHealthLifecycleDiagnostic({ ...base, action: "defer", reason: "active-prompts" }, (line) => emitted.push(JSON.parse(line.slice(line.indexOf("{"))).action));
  emitHealthLifecycleDiagnostic({ ...base, action: "recovered", reason: "healthy-reset" }, (line) => emitted.push(JSON.parse(line.slice(line.indexOf("{"))).action));
  assert.deepEqual(emitted, ["defer", "recovered"]);
});

test("termination diagnostic seam signals the exact child in order despite a throwing logger", () => {
  const child = { kill: (signal) => calls.push([child, signal]) };
  const calls = [];
  const context = { ownership: "owned", pid: 42, probe: "unhealthy", consecutiveFailures: 3, activePrompts: 1, graceRemainingMs: 0 };
  signalChildWithHealthDiagnostic({ child, signal: "SIGTERM", context, logger: () => { throw new Error("logger-secret"); } });
  signalChildWithHealthDiagnostic({ child, signal: "SIGKILL", context, logger: () => { throw new Error("logger-secret"); } });
  assert.deepEqual(calls, [[child, "SIGTERM"], [child, "SIGKILL"]]);
});

test("invalid and throwing clocks produce a safe epoch timestamp", () => {
  for (const now of [() => Number.NaN, () => { throw new Error("clock-secret"); }]) {
    const line = formatHealthLifecycleDiagnostic({ ...base, timestamp: undefined, now });
    const event = JSON.parse(line.slice(line.indexOf("{")));
    assert.equal(event.timestamp, "1970-01-01T00:00:00.000Z");
    assert.equal(line.includes("clock-secret"), false);
  }
});
