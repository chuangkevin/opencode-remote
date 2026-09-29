import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("deploy-all uses the Home tailnet health endpoint and preserves public host checks", async () => {
  const source = await readFile(new URL("../../../deploy/deploy-all.sh", import.meta.url), "utf8");

  assert.doesNotMatch(source, /opencode-home\.sisihome\.org/);
  assert.match(source, /http:\/\/100\.83\.112\.20:9223/);
  assert.match(source, /opencode-sara\.sisihome\.org/);
  assert.match(source, /opencode-l390\.sisihome\.org/);
});
