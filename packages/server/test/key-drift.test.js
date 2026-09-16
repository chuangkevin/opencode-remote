import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  detectKeyDrift,
  expectedProviderKeys,
  loadedProviderKeys,
  resolveConfigValue,
} from "../dist/key-drift.js";

test("resolveConfigValue resolves literals, file references, env references, and missing files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-key-drift-"));
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await mkdir(join(root, "keys"), { recursive: true });
  await writeFile(join(root, "keys", "newapi.key"), "file-key\n");

  const deps = {
    readFile: (path) => {
      if (path === join(root, "missing")) throw new Error("missing");
      return path === join(root, "keys", "newapi.key") ? "file-key\n" : "";
    },
    env: { NEWAPI_KEY: "env-key" },
    homedir: root,
  };

  assert.equal(resolveConfigValue("sk-literal", deps), "sk-literal");
  assert.equal(resolveConfigValue("{file:~/keys/newapi.key}", deps), "file-key");
  assert.equal(resolveConfigValue("{env:NEWAPI_KEY}", deps), "env-key");
  assert.equal(resolveConfigValue("{file:~/missing}", deps), undefined);
});

test("expectedProviderKeys parses JSONC comments and trailing commas", () => {
  const deps = {
    readFile: (path) => path === "/keys/newapi" ? "newapi-key\n" : "other-key",
    env: { OTHER_KEY: "env-other-key" },
    homedir: "/home/test",
  };
  const keys = expectedProviderKeys(`{
    // user providers
    "provider": {
      "newapi": {
        "options": {
          "apiKey": "{file:/keys/newapi}",
        },
      },
      "other": {
        "options": {
          "apiKey": "{env:OTHER_KEY}",
        },
      },
    },
  }`, deps);

  assert.deepEqual([...keys.entries()], [
    ["newapi", "newapi-key"],
    ["other", "env-other-key"],
  ]);
  assert.deepEqual([...expectedProviderKeys("{ bad json", deps).entries()], []);
});

test("loadedProviderKeys reads resolved upstream provider apiKey values", () => {
  const keys = loadedProviderKeys({
    provider: {
      newapi: { options: { apiKey: "loaded-newapi" } },
      ignored: { options: { apiKey: 123 } },
    },
  });

  assert.deepEqual([...keys.entries()], [["newapi", "loaded-newapi"]]);
});

test("detectKeyDrift reports only common providers with changed values", () => {
  assert.deepEqual(
    detectKeyDrift(new Map([["newapi", "same"]]), new Map([["newapi", "same"]])),
    [],
  );
  assert.deepEqual(
    detectKeyDrift(new Map([["newapi", "expected"]]), new Map([["newapi", "loaded"]])),
    ["newapi"],
  );
  assert.deepEqual(
    detectKeyDrift(new Map([["expected-only", "a"]]), new Map([["loaded-only", "b"]])),
    [],
  );
});

function readConfigWithEnv(envOverrides = {}) {
  const env = { ...process.env };
  delete env.OPENCODE_KEY_DRIFT_INTERVAL_MS;
  delete env.OPENCODE_KEY_DRIFT_COOLDOWN_MS;
  Object.assign(env, envOverrides);

  const configUrl = new URL("../dist/config.js", import.meta.url).href;
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { config } from ${JSON.stringify(configUrl)}; console.log(JSON.stringify({ interval: config.keyDriftIntervalMs, cooldown: config.keyDriftRestartCooldownMs }));`,
  ], { encoding: "utf8", env });

  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("config exposes key drift defaults and zero disables the interval", () => {
  assert.deepEqual(readConfigWithEnv(), { interval: 300_000, cooldown: 600_000 });
  assert.deepEqual(readConfigWithEnv({ OPENCODE_KEY_DRIFT_INTERVAL_MS: "0" }), {
    interval: 0,
    cooldown: 600_000,
  });
});
