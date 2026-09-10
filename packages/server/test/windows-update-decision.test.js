import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { compareExactSemver, decideWindowsUpdate } from "../../../deploy/windows/exact-semver.js";

const helperPath = fileURLToPath(new URL("../../../deploy/windows/exact-semver.js", import.meta.url));

test("exact semver comparison follows release, prerelease, numeric, and build rules", () => {
  assert.equal(compareExactSemver("1.0.0", "1.0.0-rc.1"), 1);
  assert.equal(compareExactSemver("1.0.0-rc.10", "1.0.0-rc.2"), 1);
  assert.equal(compareExactSemver("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareExactSemver("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareExactSemver("1.2.3+build.1", "1.2.3+build.2"), 0);
  assert.throws(() => compareExactSemver("1.0.0-01", "1.0.0"), /invalid exact semver/i);
});

test("update decision rejects downgrade and distinguishes initial migration", () => {
  assert.equal(decideWindowsUpdate("2.0.0", "1.9.9", true), "defer-downgrade");
  assert.equal(decideWindowsUpdate("2.0.0", "2.0.0", true), "current");
  assert.equal(decideWindowsUpdate("2.0.0", "2.0.0", false), "migrate");
  assert.equal(decideWindowsUpdate("2.0.0-rc.1", "2.0.0", false), "update");
});

test("semver command contract returns one exact updater decision", () => {
  const result = spawnSync(process.execPath, [helperPath, "decide", "2.0.0-rc.1", "2.0.0", "false"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "update\n");
  assert.equal(result.stderr, "");
});
