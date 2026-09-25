import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _setPiPairsRegistryPath,
  listPiPairs,
} from "../dist/compact/pi-pairs.js";

async function withRegistry(contents, run) {
  const dir = await mkdtemp(join(tmpdir(), "pi-pairs-"));
  const path = join(dir, "registry.json");
  _setPiPairsRegistryPath(path);
  try {
    if (contents !== undefined) await writeFile(path, contents, "utf8");
    await run();
  } finally {
    _setPiPairsRegistryPath(null);
    await rm(dir, { recursive: true, force: true });
  }
}

test("Pi pair registry returns an empty list when registry.json does not exist", async () => {
  await withRegistry(undefined, async () => {
    assert.deepEqual(await listPiPairs(), []);
  });
});

test("Pi pair registry maps a busy session to PairInfo", async () => {
  const session = {
    id: "ses_piPair123",
    owner: "pi-main",
    task: "verify Pi pair listing",
    status: "busy",
    lastActivityAt: 1_725_000_000_000,
    lastText: "working",
    model: { provider: "gb10", id: "gpt-5" },
  };

  await withRegistry(JSON.stringify({ sessions: { [session.id]: session } }), async () => {
    assert.deepEqual(await listPiPairs(), [{
      id: session.id,
      owner: session.owner,
      task: session.task,
      status: session.status,
      lastActivityAt: session.lastActivityAt,
      contextPct: null,
      lastText: session.lastText,
      model: session.model,
      url: "#",
    }]);
  });
});

test("Pi pair registry returns an empty list when registry.json is invalid JSON", async () => {
  await withRegistry("{ not valid json", async () => {
    assert.deepEqual(await listPiPairs(), []);
  });
});
