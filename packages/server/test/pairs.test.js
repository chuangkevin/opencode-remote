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

test("dashboard shows busy/ask/error always; idle 2h; accepted 30m", () => {
  const now = 1_000_000_000;
  const H = 3600_000;
  const M = 60_000;
  const busyIdle10h = { id: "busy", status: "busy", lastActivityAt: now - 10 * H };
  const askIdle10h = { id: "ask", status: "ask", lastActivityAt: now - 10 * H };
  const errorUnaccepted10h = { id: "err", status: "error", lastActivityAt: now - 10 * H };
  const idle1h = { id: "idle1", status: "idle", lastActivityAt: now - 1 * H };
  const idle3h = { id: "idle3", status: "idle", lastActivityAt: now - 3 * H };
  const accepted20m = { id: "acc20", status: "idle", lastActivityAt: now - 20 * M, acceptedAt: now - 25 * M };
  const accepted40m = { id: "acc40", status: "idle", lastActivityAt: now - 40 * M, acceptedAt: now - 50 * M };
  assert.equal(dashboardVisible(busyIdle10h, now), true);
  assert.equal(dashboardVisible(askIdle10h, now), true);
  assert.equal(dashboardVisible(errorUnaccepted10h, now), true);
  assert.equal(dashboardVisible(idle1h, now), true);
  assert.equal(dashboardVisible(idle3h, now), false);
  assert.equal(dashboardVisible(accepted20m, now), true);
  assert.equal(dashboardVisible(accepted40m, now), false);
  // accepted busy still shows even when idle long (rule 1 beats rule 2)
  assert.equal(dashboardVisible({ id: "x", status: "busy", lastActivityAt: now - 10 * H, acceptedAt: now - 10 * H }, now), true);
  assert.deepEqual(
    visiblePairs([accepted40m, idle3h, idle1h, accepted20m, errorUnaccepted10h, askIdle10h, busyIdle10h], "dashboard", now).map((p) => p.id),
    ["acc20", "idle1", "err", "ask", "busy"],
  );
  // list view shows everything newest first (40m > 1h > 3h)
  assert.deepEqual(
    visiblePairs([accepted40m, idle3h, idle1h], "list", now).map((p) => p.id),
    ["acc40", "idle1", "idle3"],
  );
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

test("pairs phone dashboard is one row per card", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const page = source.slice(source.indexOf("async function handlePairsPage"), source.indexOf("async function handleListPins"));
  // 手機儀表板：單欄、一行一筆（task 單行截斷、lastText 單行、owner/ctxbar 隱藏）。
  assert.match(page, /@media \(max-width: 767px\)/);
  assert.match(page, /body\[data-view="dashboard"\] \.grid \{ grid-template-columns: 1fr; \}/);
  assert.match(page, /body\[data-view="dashboard"\] \.task \{[^}]*white-space: nowrap/s);
  assert.match(page, /body\[data-view="dashboard"\] \.lasttext \{ -webkit-line-clamp: 1;/);
  assert.match(page, /body\[data-view="dashboard"\] \.ctxrow \{ display: none; \}/);
  assert.match(page, /body\[data-view="dashboard"\] \.owner \{ display: block; \}/);
  // 卡片整行可點（a.card 包 task＋時間＋lastText；彙總模式開絕對網址）。
  const client = await readFile(new URL("../static/pairs.js", import.meta.url), "utf8");
  assert.match(client, /a\.href = AGGREGATE/);
  assert.match(client, /card-row/);
});

test("sessions and pairs pages link to each other", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  // /remote-sessions header has a 夥伴 button with the live pair count.
  assert.match(source, /<a class="pairs-btn" href="\/pairs">夥伴\$\{pairCount > 0 \? ` \$\{pairCount\}` : ""\}<\/a>/);
  assert.match(source, /const pairCount = allSessions\.length - visibleSessions\.length;/);
  // /pairs header links back.
  assert.match(source, /<a class="pairs-btn" href="\/remote-sessions"/);
});

test("api pairs allows cross-origin GET for the aggregate page", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /"Access-Control-Allow-Origin": "\*",/);
  const pairsBlock = source.slice(source.indexOf("async function handleListPairs"), source.indexOf("const PAIR_ACCEPT_PATH_RE"));
  assert.match(pairsBlock, /Access-Control-Allow-Origin/);
  assert.match(source, /req\.url === "\/api\/pairs"\)/);
  assert.match(source, /\/api\/session\/active" \|\| req\.url === "\/api\/pairs"/);
});

test("pairs aggregate mode merges remotes with host tags", async () => {
  const { readFile } = await import("node:fs/promises");
  const client = await readFile(new URL("../static/pairs.js", import.meta.url), "utf8");
  assert.match(client, /opencode-hub:remotes/);
  assert.match(client, /https:\/\/opencode-sara\.sisihome\.org/);
  assert.match(client, /\/api\/pairs/);
  assert.match(client, /host-tag/);
  assert.match(client, /連不上，只顯示其他台/);
  assert.match(client, /location\.hostname === "opencode\.sisihome\.org"/);
});

test("pairs cards show owner, model, and labelled context bar", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../static/pairs.js", import.meta.url), "utf8");
  assert.match(client, /派工：\$\{pair\.owner\}/);
  assert.match(client, /<div class="partner">夥伴：OpenCode<\/div>/);
  assert.match(client, /`模型：\$\{label\}`/);
  assert.match(client, /context \$\{pair\.contextPct\}%/);
  assert.match(client, /對話已用掉模型上限的 \$\{pair\.contextPct\}%/);
  assert.match(client, /ctxbar\$\{over \? " over" : ""\}/);
  assert.match(source, /\.ctxbar\.over > i \{ background: #f59e0b; \}/);
  assert.match(client, /<b><\/b><\/div>/);
});

test("pairs agg note hides when all remotes are up; card time never wraps", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /\.agg-note \{ display: none;/);
  assert.match(source, /\.agg-note\.show \{ display: block; \}/);
  assert.match(source, /\.card-top \.meta \{ flex-shrink: 0; white-space: nowrap; \}/);
  assert.match(source, /\.card-top \.owner \{ flex: 1; min-width: 0; \}/);
  const client = await readFile(new URL("../static/pairs.js", import.meta.url), "utf8");
  assert.match(client, /aggNote\.classList\.add\("show"\)/);
  assert.match(client, /aggNote\.classList\.remove\("show"\)/);
});

test("hub tabs keep their status dots across re-renders", async () => {
  const { readFile } = await import("node:fs/promises");
  const hub = await readFile(new URL("../static/hub.html", import.meta.url), "utf8");
  assert.match(hub, /const lastDot = new Map\(\)/);
  assert.match(hub, /lastDot\.set\(r\.id/);
  assert.match(hub, /lastDot\.get\(r\.id\)/);
});

test("pairs model is a full object; cards show a wrapped model line", async () => {
  const { readFile } = await import("node:fs/promises");
  const client = await readFile(new URL("../static/pairs.js", import.meta.url), "utf8");
  // 模型獨立一行、不截斷、可換行；variant 非 default 才加。
  assert.match(client, /modelFullLabel\(pair\.model\)/);
  assert.match(client, /`模型：\$\{label\}`/);
  assert.match(client, /model-provider/);
  assert.match(client, /modelShortId\(pair\.model\)/);
  assert.match(client, /taskEl\.title = modelFullLabel\(pair\.model\)/);
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /\.model-line \{[^}]*overflow-wrap: anywhere/s);
  assert.match(source, /word-break: break-all/);
  assert.match(source, /body\[data-view="list"\] \.model-line \{ display: none; \}/);
});

test("pairs model object carries provider, id, and non-default variant", async () => {
  const { computePairInfo } = await import("../dist/compact/pairs.js");
  const base = { id: "ses_x", title: "pair·o·t" };
  const full = computePairInfo(
    { ...base, model: { providerID: "newapi-oai", id: "pair/meta/muse-spark-1.3-contributor", variant: "low" } },
    { busy: false, formPending: false, messages: [] },
  );
  assert.deepEqual(full.model, {
    provider: "newapi-oai",
    id: "pair/meta/muse-spark-1.3-contributor",
    variant: "low",
  });
  const noVariant = computePairInfo(
    { ...base, model: { providerID: "p", modelID: "m" } },
    { busy: false, formPending: false, messages: [] },
  );
  assert.deepEqual(noVariant.model, { provider: "p", id: "m" });
  const none = computePairInfo(base, { busy: false, formPending: false, messages: [] });
  assert.equal(none.model, undefined);
});
