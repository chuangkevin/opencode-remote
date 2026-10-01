import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import { commitHealthRecoveryOutcome, decideManagedServiceRecovery, managedSpawnExitAction, nextHealthState, ownsManagedSpawn, validateManagedServiceIdentity, handleRestartReadinessFailure } from "../dist/health-watchdog.js";

test("unmanaged restart readiness failure terminates the exact candidate before fatal exit", async () => {
  const candidate = { name: "newly spawned candidate" };
  const calls = [];
  await handleRestartReadinessFailure({
    serviceMode: false,
    candidate,
    terminateCandidate: async (child) => calls.push(["terminate", child]),
    fatalExit: async () => calls.push(["fatal"]),
    managedFailure: async () => calls.push(["managed"]),
  });
  assert.deepEqual(calls, [["terminate", candidate], ["fatal"]]);
});

test("managed restart readiness failure preserves shared service without terminating candidate", async () => {
  const candidate = { name: "candidate beside shared service" };
  const calls = [];
  await handleRestartReadinessFailure({
    serviceMode: true,
    candidate,
    terminateCandidate: async (child) => calls.push(["terminate", child]),
    fatalExit: async () => calls.push(["fatal"]),
    managedFailure: async () => calls.push(["managed", candidate]),
  });
  assert.deepEqual(calls, [["managed", candidate]]);
});

test("managed identity validation retains only a strict loopback origin", () => {
  assert.deepEqual(validateManagedServiceIdentity({ url: "http://user:secret@127.0.0.1:43210/path?q=secret", pid: 321 }), {
    url: "http://127.0.0.1:43210", port: 43210, pid: 321,
  });
  assert.deepEqual(validateManagedServiceIdentity({ url: "http://localhost:80", pid: 321 }), {
    url: "http://localhost", port: 80, pid: 321,
  });
  for (const descriptor of [
    { url: "http://127.0.0.1", pid: 321 },
    { url: "http://127.0.0.1:0", pid: 321 },
    { url: "http://example.com:43210", pid: 321 },
    { url: "http://127.0.0.1:43210", pid: 0 },
    { url: "http://127.0.0.1:43210", pid: 1.5 },
    { url: "not a url", pid: 321 },
  ]) assert.equal(validateManagedServiceIdentity(descriptor), undefined);
});

test("startup shared identity can be retained and recovery requires matching valid snapshot", async () => {
  const identity = validateManagedServiceIdentity({ url: "http://127.0.0.1:43210", pid: 321 });
  assert.ok(identity);
  const absent = async () => "absent";
  const verify = (snapshot) => decideManagedServiceRecovery({
    port: identity.port, pid: identity.pid, timeoutMs: 20, probe: absent, isPidAlive: () => false,
    getSnapshot: async () => snapshot,
  });
  assert.equal((await verify(identity)).action, "spawn");
  for (const snapshot of [undefined, { ...identity, url: "bad" }, { ...identity, pid: 456 }]) {
    assert.equal((await verify(snapshot)).action, "defer");
  }
  assert.deepEqual(commitHealthRecoveryOutcome({ consecutiveFailures: 3, lastRestartAt: 100, recoveryDeferredAt: 50 }, { consecutiveFailures: 0 }, "skipped", 200), {
    consecutiveFailures: 3, lastRestartAt: 100, recoveryDeferredAt: 50,
  });
});

test("actual owned readiness records cooldown, while skipped and unmanaged paths preserve legacy state", () => {
  const restarted = commitHealthRecoveryOutcome({ consecutiveFailures: 3, recoveryDeferredAt: 25 }, { consecutiveFailures: 0 }, "owned-ready", 500);
  assert.deepEqual(restarted, {
    consecutiveFailures: 0, lastRestartAt: 500, cooldownWarnedForRestartAt: undefined,
  });
  assert.equal(nextHealthState(restarted, false, 600, { failures: 1, restartCooldownMs: 1_000 }).action, "cooldown");
  assert.deepEqual(commitHealthRecoveryOutcome({ consecutiveFailures: 3, lastRestartAt: 100, recoveryDeferredAt: 50 }, { consecutiveFailures: 0 }, "shared-reused", 500), {
    consecutiveFailures: 3, lastRestartAt: 100, recoveryDeferredAt: 50,
  });
  assert.deepEqual(commitHealthRecoveryOutcome({ consecutiveFailures: 3, lastRestartAt: 100, recoveryDeferredAt: 50 }, { consecutiveFailures: 0 }, "failed", 500), {
    consecutiveFailures: 3, lastRestartAt: 100, recoveryDeferredAt: 50,
  });
  assert.deepEqual(commitHealthRecoveryOutcome({ consecutiveFailures: 3, lastRestartAt: 100 }, { consecutiveFailures: 0 }, "owned-ready", 500, false), {
    consecutiveFailures: 0,
  });
});

test("unhealthy but occupied shared listener defers startup", async () => {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  try {
    const result = await decideManagedServiceRecovery({ port, pid: process.pid, timeoutMs: 100 });
    assert.equal(result.action, "defer");
    assert.equal(result.reason, "listener-occupied");
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

test("live shared PID with no listener and unknown PID fail closed", async () => {
  const absent = async () => "absent";
  assert.deepEqual(await decideManagedServiceRecovery({ port: 1, pid: process.pid, timeoutMs: 20, probe: absent }), {
    action: "defer", reason: "shared-pid-live",
  });
  assert.deepEqual(await decideManagedServiceRecovery({ port: 1, timeoutMs: 20, probe: absent }), {
    action: "defer", reason: "pid-unknown",
  });
  assert.deepEqual(await decideManagedServiceRecovery({ port: 1, pid: 123, timeoutMs: 20, probe: absent, isPidAlive: () => false }), {
    action: "spawn", reason: "listener-absent-pid-dead",
  });
  let snapshotReads = 0;
  const changing = await decideManagedServiceRecovery({
    port: 43210, pid: 123, timeoutMs: 20, probe: absent, isPidAlive: () => false,
    getSnapshot: async () => ++snapshotReads === 1
      ? { url: "http://127.0.0.1:43210", port: 43210, pid: 123 }
      : { url: "http://127.0.0.1:43210", port: 43210, pid: 456 },
  });
  assert.equal(changing.action, "defer");
  assert.equal(changing.reason, "managed-snapshot-changed-or-invalid");
});

test("unknown listener state and connect timeout fail closed", async () => {
  assert.equal((await decideManagedServiceRecovery({ port: 1, pid: 123, timeoutMs: 2, probe: async () => "unknown" })).action, "defer");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    assert.equal((await decideManagedServiceRecovery({ port, pid: 123, timeoutMs: 100 })).reason, "listener-occupied");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("listener acquired between initial check and final check prevents spawn", async () => {
  let calls = 0;
  const result = await decideManagedServiceRecovery({
    port: 123, pid: 123, timeoutMs: 20, isPidAlive: () => false,
    probe: async () => ++calls === 1 ? "absent" : "occupied",
  });
  assert.deepEqual(result, { action: "defer", reason: "listener-acquired" });
  assert.equal(calls, 2);
});

test("owned recovery eligibility requires confirmed dead PID and absent listener", async () => {
  const result = await decideManagedServiceRecovery({ port: 1, pid: 123, timeoutMs: 20, probe: async () => "absent", isPidAlive: () => false });
  assert.equal(result.action, "spawn");
});

test("shared healthy reuse remains non-owned and bind collision preserves shared state", () => {
  const original = { exitCode: null, signalCode: null, pid: 4123 };
  const separateChild = { exitCode: null, signalCode: null, pid: 5123 };
  assert.equal(ownsManagedSpawn(separateChild, original, false), false);
  assert.equal(ownsManagedSpawn(separateChild, separateChild, true, 5123), true);
  assert.equal(managedSpawnExitAction(true, "occupied"), "preserve-shared");
  assert.equal(managedSpawnExitAction(true, "unknown"), "preserve-shared");
  assert.equal(managedSpawnExitAction(true, "absent"), "fatal");
});

test("an exited candidate that observed shared readiness never becomes owned", () => {
  const exitedCandidate = { exitCode: 0, signalCode: null, pid: 4123 };
  // `waitForOpenCode` may have succeeded because a different service is ready.
  assert.equal(ownsManagedSpawn(exitedCandidate, exitedCandidate, true), false);
});

test("managed ownership rejects unknown and mismatched descriptor identities", () => {
  const child = { exitCode: null, signalCode: null, pid: 4123 };
  assert.equal(ownsManagedSpawn(child, child, true), false);
  assert.equal(ownsManagedSpawn(child, child, true, 4123), true);
  assert.equal(ownsManagedSpawn(child, child, true, 9999), false);
  assert.equal(ownsManagedSpawn(child, child, true, undefined), false);
});

test("managed recovery rejects malformed and non-loopback descriptor URLs", async () => {
  for (const url of ["not a url", "http://192.0.2.10:43210", "http://127.0.0.1:43211"]) {
    const result = await decideManagedServiceRecovery({
      port: 43210, pid: 123, timeoutMs: 20, probe: async () => "absent", isPidAlive: () => false,
      getSnapshot: async () => ({ url, port: 43210, pid: 123 }),
    });
    assert.equal(result.action, "defer", url);
  }
});
