import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _setPairsStoreDir,
  acceptPair,
  buildPairsList,
  computePairInfo,
  getAcceptedAt,
  isPairSession,
  listAccepted,
  parsePairTitle,
  unacceptPair,
} from "../dist/compact/pairs.js";
import {
  dashboardVisible,
  formatRelative,
  visiblePairs,
} from "../static/pairs.js";

function assistant({ text = "", tokens = undefined, created = 1000, completed = 1000, error = undefined, flat = false } = {}) {
  // flat:true emits the real 2.x shape (no info wrapper).
  const body = {
    ...(error ? { error } : {}),
    ...(tokens ? { tokens } : {}),
    time: { created, streamed: completed, completed },
  };
  return {
    type: "assistant",
    ...(flat ? body : { info: body }),
    content: text ? [{ type: "text", text }] : [],
  };
}

test("pair title parses owner and task on U+00B7 separators", () => {
  assert.deepEqual(parsePairTitle("pair·ses_owner123·do the thing"), { owner: "ses_owner123", task: "do the thing" });
  assert.deepEqual(parsePairTitle("pair·o·a·b"), { owner: "o", task: "a·b" });
  assert.equal(parsePairTitle("OpencodeRemote_0923-3"), undefined);
  assert.equal(parsePairTitle("pair·onlyowner"), undefined);
  assert.equal(parsePairTitle("pair··notask"), undefined);
  assert.equal(isPairSession({ title: "pair·o·t" }), true);
  assert.equal(isPairSession({ title: "normal" }), false);
});

test("status: busy beats ask beats error beats idle", () => {
  const session = { id: "ses_x", title: "pair·o·t" };
  const errMsg = assistant({ text: "x", error: { type: "boom", message: "m" } });
  const errFlat = assistant({ text: "x", error: { type: "boom", message: "m" }, flat: true });
  assert.equal(computePairInfo(session, { busy: true, formPending: true, messages: [errMsg] }).status, "busy");
  assert.equal(computePairInfo(session, { busy: false, formPending: true, messages: [errMsg] }).status, "ask");
  assert.equal(computePairInfo(session, { busy: false, formPending: false, messages: [errMsg] }).status, "error");
  assert.equal(computePairInfo(session, { busy: false, formPending: false, messages: [errFlat] }).status, "error");
  assert.equal(
    computePairInfo(session, { busy: false, formPending: false, messages: [assistant({ text: "ok" })] }).status,
    "idle",
  );
});

test("contextPct uses input+cache.read over the model limit; lastText is the newest 200 chars", () => {
  const session = { id: "ses_x", title: "pair·o·t", model: { providerID: "p", modelID: "m" } };
  const info = computePairInfo(session, {
    busy: false,
    formPending: false,
    messages: [
      assistant({ text: "second", tokens: { input: 1000, cache: { read: 9000 } }, created: 2000, completed: 2000, flat: true }),
      assistant({ text: "first", tokens: { input: 10, cache: { read: 10 } }, created: 1000, completed: 1000, flat: true }),
    ],
    contextLimit: 200000,
  });
  assert.equal(info.contextPct, 5);
  assert.equal(info.lastActivityAt, 2000);
  assert.equal(info.lastText, "second");
  assert.equal(info.url, "/c/session/ses_x");

  const long = computePairInfo(session, {
    busy: false,
    formPending: false,
    messages: [assistant({ text: "z".repeat(500) })],
  });
  assert.equal(long.lastText.length, 200);
  assert.equal(long.contextPct, null);
});

test("accept store round-trips through an atomic JSON file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pairs-accept-"));
  _setPairsStoreDir(dir);
  try {
    assert.equal(await getAcceptedAt("ses_aaa"), undefined);
    const at = await acceptPair("ses_aaa", 1234567890);
    assert.equal(at, 1234567890);
    assert.equal(await getAcceptedAt("ses_aaa"), 1234567890);
    assert.deepEqual(await listAccepted(), { ses_aaa: 1234567890 });
    await unacceptPair("ses_aaa");
    assert.equal(await getAcceptedAt("ses_aaa"), undefined);
    await assert.rejects(() => acceptPair("bogus", 1), /invalid session id/);
  } finally {
    _setPairsStoreDir(null);
  }
});

test("buildPairsList assembles fields and isolates per-session failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pairs-list-"));
  _setPairsStoreDir(dir);
  try {
    await acceptPair("ses_ok", 777);
    const pairs = await buildPairsList({
      listPairSessions: async () => [
        { id: "ses_ok", title: "pair·owner1·fix login", model: { providerID: "p", modelID: "m" } },
        { id: "ses_bad", title: "pair·o·broken", model: { providerID: "p", modelID: "m" } },
      ],
      fetchBusySet: async () => new Set(["ses_ok"]),
      fetchForm: async () => [],
      fetchMessages: async (id) => {
        if (id === "ses_bad") throw new Error("upstream down");
        return [assistant({ text: "hello world", tokens: { input: 500, cache: { read: 500 } }, created: 9000, completed: 9000, flat: true })];
      },
      fetchContextLimit: async () => 10000,
      messageLimit: 40,
    });
    assert.equal(pairs.length, 2);
    const ok = pairs.find((p) => p.id === "ses_ok");
    assert.equal(ok.owner, "owner1");
    assert.equal(ok.task, "fix login");
    assert.equal(ok.status, "busy");
    assert.equal(ok.contextPct, 10);
    assert.equal(ok.lastText, "hello world");
    assert.equal(ok.lastActivityAt, 9000);
    assert.equal(ok.acceptedAt, 777);
    const bad = pairs.find((p) => p.id === "ses_bad");
    assert.equal(bad.status, "idle");
    assert.equal(bad.lastActivityAt, 0);
  } finally {
    _setPairsStoreDir(null);
  }
});

test("dashboard keeps unaccepted forever; accepted vanish after 30 idle minutes", () => {
  const now = 1_000_000_000;
  const fresh = { id: "a", lastActivityAt: now - 1000 };
  const oldUnaccepted = { id: "b", lastActivityAt: now - 3600_000 };
  const oldAccepted = { id: "c", lastActivityAt: now - 3600_000, acceptedAt: now - 7200_000 };
  const recentAccepted = { id: "d", lastActivityAt: now - 1000, acceptedAt: now - 2000 };
  assert.equal(dashboardVisible(fresh, now), true);
  assert.equal(dashboardVisible(oldUnaccepted, now), true);
  assert.equal(dashboardVisible(oldAccepted, now), false);
  assert.equal(dashboardVisible(recentAccepted, now), true);
  assert.deepEqual(visiblePairs([oldAccepted, oldUnaccepted, fresh], "dashboard", now).map((p) => p.id), ["a", "b"]);
  assert.deepEqual(visiblePairs([oldAccepted, fresh], "list", now).map((p) => p.id), ["a", "c"]);
});

test("relative time ticks in Chinese units", () => {
  const now = 1_000_000;
  assert.equal(formatRelative(now - 5000, now), "5 秒前");
  assert.equal(formatRelative(now - 120_000, now), "2 分鐘前");
  assert.equal(formatRelative(now - 7200_000, now), "2 小時前");
  assert.equal(formatRelative(now - 90_000_000, now), "1 天前");
});

test("remote-sessions list filters pair sessions server-side", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /isPairSession/);
  assert.match(source, /Pair-partner sessions/);
});

test("pairs page ships both views and reduced-motion rules", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const page = source.slice(source.indexOf("async function handlePairsPage"), source.indexOf("async function handleListPins"));
  assert.match(page, /data-view-btn="dashboard"/);
  assert.match(page, /data-view-btn="list"/);
  assert.match(page, /prefers-reduced-motion/);
  assert.match(page, /pairs\.js\?v=/);
  const client = await readFile(new URL("../static/pairs.js", import.meta.url), "utf8");
  assert.match(client, /PAIRS_VIEW_KEY = "pairs-view"/);
  assert.match(client, /prefers-reduced-motion/);
  assert.match(client, /setInterval\(poll, 3000\)/);
  assert.match(client, /data-view-btn/);
});
