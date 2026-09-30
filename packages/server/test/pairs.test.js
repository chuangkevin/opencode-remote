import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _setPairsStoreDir,
  _setClaudeSessionDir,
  acceptPair,
  buildPairsList,
  computePairInfo,
  createPairsCache,
  getClaudeArchivedOwners,
  getAcceptedAt,
  isPairSession,
  listAccepted,
  parsePairTitle,
  unacceptPair,
  pairArchived,
} from "../dist/compact/pairs.js";
import {
  archivedPair,
  dashboardVisible,
  formatRelative,
  pairCardUrl,
  partnerLabel,
  visiblePairs,
  withBase,
  mergeAggregatePairs,
  aggregateLoading,
  remoteIsOffline,
  parsePairsState,
  pairsStateUrl,
} from "../static/pairs.js";
import { hubHostUrl, parseHubHost, rewriteHubSessionHref } from "../static/hub-state.js";

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
  assert.equal(info.partner, "opencode");

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

test("dashboard shows busy/ask; idle 2h; accepted 30m; errors are archived", () => {
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
  assert.equal(dashboardVisible(errorUnaccepted10h, now), false);
  assert.equal(dashboardVisible(idle1h, now), true);
  assert.equal(dashboardVisible(idle3h, now), false);
  assert.equal(dashboardVisible(accepted20m, now), true);
  assert.equal(dashboardVisible(accepted40m, now), false);
  // accepted busy still shows even when idle long (rule 1 beats rule 2)
  assert.equal(dashboardVisible({ id: "x", status: "busy", lastActivityAt: now - 10 * H, acceptedAt: now - 10 * H }, now), true);
  assert.deepEqual(
    visiblePairs([accepted40m, idle3h, idle1h, accepted20m, errorUnaccepted10h, askIdle10h, busyIdle10h], "dashboard", now).map((p) => p.id),
    ["acc20", "idle1", "ask", "busy"],
  );
  // list view excludes archived pairs, but keeps newest-first order.
  assert.deepEqual(
    visiblePairs([accepted40m, idle3h, idle1h], "list", now).map((p) => p.id),
    ["acc40", "idle1"],
  );
});

test("pairs archive errors immediately and idle pairs after 2 hours", () => {
  const now = 1_000_000_000;
  const hour = 3600_000;
  const idle2h01 = { id: "idle2h01", status: "idle", lastActivityAt: now - 2 * hour - 1 };
  const idle1h59 = { id: "idle1h59", status: "idle", lastActivityAt: now - 2 * hour + 1 };
  assert.equal(archivedPair({ id: "error", status: "error", lastActivityAt: now }, now), true);
  assert.equal(archivedPair(idle2h01, now), true);
  assert.equal(archivedPair(idle1h59, now), false);
  assert.equal(archivedPair({ ...idle2h01, status: "busy" }, now), false);
  assert.equal(archivedPair({ ...idle2h01, status: "ask" }, now), false);
  assert.deepEqual(visiblePairs([idle2h01, idle1h59], "archived", now).map((p) => p.id), ["idle2h01"]);
});

test("buildPairsList skips expensive message/context reads for stale idle sessions", async () => {
  const now = 1_000_000_000;
  let messages = 0;
  let contexts = 0;
  const pairs = await buildPairsList({
    listPairSessions: async () => [{ id: "ses_old", title: "pair·o·old", time: { updated: now - 2 * 3600_000 - 1 } }],
    fetchBusySet: async () => new Set(),
    fetchForm: async () => [],
    fetchMessages: async () => { messages += 1; return []; },
    fetchContextLimit: async () => { contexts += 1; return 100; },
  }, { includeArchived: true, now });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].lastActivityAt, now - 2 * 3600_000 - 1);
  assert.equal(messages, 0);
  assert.equal(contexts, 0);
});

test("Claude archive lookup is cached, conservative, and never archives busy pairs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-pairs-"));
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "archived.json"), JSON.stringify({ title: "OpencodeRemote_0930_1", isArchived: true }));
  await writeFile(join(dir, "active.json"), JSON.stringify({ title: "OpencodeRemote_0930_2", isArchived: false }));
  await writeFile(join(dir, "duplicate-a.json"), JSON.stringify({ title: "Ambiguous", isArchived: true }));
  await writeFile(join(dir, "duplicate-b.json"), JSON.stringify({ title: "Ambiguous", isArchived: false }));
  await writeFile(join(dir, "nested", "broken.json"), "not json");
  _setClaudeSessionDir(dir);
  try {
    const owners = await getClaudeArchivedOwners(1_000);
    assert.equal(owners.has("OpencodeRemote_0930_1"), true);
    assert.equal(owners.has("OpencodeRemote_0930_2"), false);
    assert.equal(owners.has("Missing"), false);
    assert.equal(owners.has("Ambiguous"), false);
    assert.equal(pairArchived({ owner: "OpencodeRemote_0930_1", status: "idle", lastActivityAt: 1_000 }, 1_000, owners), true);
    assert.equal(pairArchived({ owner: "OpencodeRemote_0930_1", status: "busy", lastActivityAt: 1_000 }, 1_000, owners), false);
  } finally {
    _setClaudeSessionDir(null);
  }
  _setClaudeSessionDir(join(dir, "does-not-exist"));
  try {
    assert.deepEqual([...await getClaudeArchivedOwners(2_000)], []);
  } finally {
    _setClaudeSessionDir(null);
  }
});

test("aggregate helpers merge freshest cards and keep offline state for its cooldown", () => {
  const merged = mergeAggregatePairs([
    [{ id: "same", hostUrl: "https://a", lastActivityAt: 1 }, { id: "old", hostUrl: "https://a", lastActivityAt: 1 }],
    [{ id: "same", hostUrl: "https://b", lastActivityAt: 2 }],
  ]);
  assert.deepEqual(merged.map((pair) => pair.id), ["same", "old"]);
  assert.equal(remoteIsOffline(1_000, 1_000 + 59_999), true);
  assert.equal(remoteIsOffline(1_000, 1_000 + 60_000), false);
  assert.equal(aggregateLoading(0, 1), true);
  assert.equal(aggregateLoading(0, 0), false);
  assert.equal(aggregateLoading(1, 2), false);
  // A failed refresh contributes no new list; the previous successful list remains renderable.
  assert.deepEqual(mergeAggregatePairs([merged]), merged);
});

test("pairs cache serves fresh data, revalidates stale data once, and isolates archived views", async () => {
  let now = 0;
  let calls = 0;
  let finishSecond;
  const cache = createPairsCache(() => now);
  const build = async () => {
    calls += 1;
    if (calls === 2) await new Promise((resolve) => { finishSecond = resolve; });
    return [{ id: `pair-${calls}` }];
  };

  assert.deepEqual(await cache.get(false, build), [{ id: "pair-1" }]);
  now = 2_000;
  assert.deepEqual(await cache.get(false, build), [{ id: "pair-1" }]);
  assert.equal(calls, 1);
  now = 4_000;
  assert.deepEqual(await cache.get(false, build), [{ id: "pair-1" }]);
  assert.deepEqual(await cache.get(false, build), [{ id: "pair-1" }]);
  assert.equal(calls, 2);
  finishSecond();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await cache.get(false, build), [{ id: "pair-2" }]);
  assert.deepEqual(await cache.get(true, build), [{ id: "pair-3" }]);
  assert.equal(calls, 3);
});

test("pairs cache keeps stale data after refresh failure and waits on first failure", async () => {
  let now = 0;
  let calls = 0;
  const cache = createPairsCache(() => now);
  const first = await cache.get(false, async () => {
    calls += 1;
    return ["old"];
  });
  assert.deepEqual(first, ["old"]);
  now = 4_000;
  assert.deepEqual(await cache.get(false, async () => {
    calls += 1;
    throw new Error("refresh failed");
  }), ["old"]);
  assert.equal(calls, 2);

  const empty = createPairsCache(() => now);
  await assert.rejects(() => empty.get(false, async () => {
    calls += 1;
    throw new Error("initial failed");
  }), /pairs cache refresh failed/);
});

test("partnerLabel identifies Pi and defaults legacy pairs to OpenCode", () => {
  assert.equal(partnerLabel({ partner: "pi" }), "Pi");
  assert.equal(partnerLabel({ partner: "opencode" }), "OpenCode");
  assert.equal(partnerLabel({}), "OpenCode");
});

test("pair card URLs use the owning prefix outside aggregate mode", () => {
  const pair = { url: "/c/session/ses_test" };
  const ownPath = (path) => withBase("/sara", path);
  assert.equal(pairCardUrl(pair, false, ownPath), "/sara/c/session/ses_test");
  assert.equal(pairCardUrl(pair, false, (path) => path), "/c/session/ses_test");
  assert.equal(
    pairCardUrl({ ...pair, hostUrl: "https://remote.example///" }, true, ownPath),
    "https://remote.example/c/session/ses_test",
  );
  assert.equal(pairCardUrl({ url: "#" }, false, ownPath), "#");
});

test("base paths only prefix root-relative URLs", () => {
  assert.equal(withBase("/sara", "/c/session/x"), "/sara/c/session/x");
  assert.equal(withBase("/sara", "#"), "#");
  assert.equal(withBase("/sara", ""), "");
  assert.equal(withBase("/sara", "https://remote.example/c/session/x"), "https://remote.example/c/session/x");
  assert.equal(withBase("", "/c/session/x"), "/c/session/x");
  assert.equal(withBase("", "#"), "#");
  assert.equal(withBase("", ""), "");
});

test("pairs URL parses and serializes host/view state, with legacy view fallback only when omitted", () => {
  assert.deepEqual(parsePairsState("?host=l390&view=archived", "list"), { host: "l390", view: "archived" });
  assert.deepEqual(parsePairsState("?host=invalid", "list"), { host: "mac", view: "list" });
  assert.deepEqual(parsePairsState("?view=invalid", "archived"), { host: "mac", view: "dashboard" });
  assert.equal(pairsStateUrl({ host: "mac", view: "dashboard" }), "/pairs");
  assert.equal(pairsStateUrl({ host: "l390", view: "archived" }), "/pairs?host=l390&view=archived");
  assert.equal(pairsStateUrl({ host: "mac", view: "dashboard" }, true), "/pairs?view=dashboard");
  assert.equal(pairsStateUrl({ host: "mac", view: "list" }, true, "/sara"), "/sara/pairs?view=list");
});

test("Hub host state parses URL before storage and serializes a shareable URL", () => {
  assert.equal(parseHubHost("?host=l390", "home"), "l390");
  assert.equal(parseHubHost("?host=invalid", "home"), "home");
  assert.equal(parseHubHost("", "invalid"), "mac");
  assert.equal(parseHubHost("?host=mac", "home"), "mac");
  assert.equal(hubHostUrl("l390"), "/?host=l390");
  assert.equal(hubHostUrl("invalid"), "/?host=mac");
});

test("Hub session links rewrite to the selected root-domain machine prefix", () => {
  assert.equal(rewriteHubSessionHref("/sara/c/session/ses_mac", "/sara"), "/sara/c/session/ses_mac");
  assert.equal(rewriteHubSessionHref("https://opencode-l390.sisihome.org/server/abc/session/ses_l390", "/l390"), "/l390/server/abc/session/ses_l390");
  assert.equal(rewriteHubSessionHref("/c/session/ses_x?from=hub#chat", "/home"), "/home/c/session/ses_x?from=hub#chat");
  assert.equal(rewriteHubSessionHref("/remote-sessions", "/sara"), undefined);
});

test("aggregate cards stay under the matching root-domain machine prefix", () => {
  const ownPath = (path) => path;
  assert.equal(pairCardUrl({ hostUrl: "https://opencode.sisihome.org/sara", url: "/c/session/ses_mac" }, true, ownPath), "https://opencode.sisihome.org/sara/c/session/ses_mac");
  assert.equal(pairCardUrl({ hostUrl: "https://opencode.sisihome.org/l390", url: "/c/session/ses_l390" }, true, ownPath), "https://opencode.sisihome.org/l390/c/session/ses_l390");
  assert.equal(pairCardUrl({ hostUrl: "https://opencode.sisihome.org/home", url: "/c/session/ses_home" }, true, ownPath), "https://opencode.sisihome.org/home/c/session/ses_home");
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
  assert.match(client, /dataset\.viewBtn = "archived"/);
  assert.match(client, /textContent = "已歸檔"/);
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
  assert.match(client, /a\.href = pairCardUrl\(pair, AGGREGATE, ownPath\)/);
  assert.match(client, /: ownPath\(pair\.url\)/);
  assert.match(client, /fetch\(ownPath\("\/api\/pairs"\)\)/);
  assert.match(client, /card-row/);
  assert.match(page, /\.host-tabs \{ display: flex; gap: 6px; overflow-x: auto;/);
  assert.match(page, /\.host-tabs \{[^}]*max-width: 100%/);
  assert.match(page, /body \{[^}]*overflow-x: hidden/s);
});

test("pairs-rules.js serves the single dashboard rule set", async () => {
  const rules = await import("../static/pairs-rules.js");
  const { visiblePairs } = await import("../static/pairs.js");
  assert.equal(rules.DASHBOARD_ACTIVE_MS, 30 * 60 * 1000);
  assert.equal(rules.DASHBOARD_IDLE_MS, 2 * 60 * 60 * 1000);
  // Re-exported from pairs.js so existing import paths keep working.
  assert.equal(visiblePairs, rules.visiblePairs);
  assert.equal(rules.dashboardVisible({ status: "busy", lastActivityAt: 0 }, 10 * 3600_000), true);
  const { readFile } = await import("node:fs/promises");
  const assets = await readFile(new URL("../src/compact/static-assets.ts", import.meta.url), "utf8");
  assert.match(assets, /"pairs-rules\.js": "application\/javascript; charset=utf-8"/);
  assert.match(assets, /"hub-state\.js": "application\/javascript; charset=utf-8"/);
});

test("sessions badge counts dashboard-visible pairs client-side", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const page = source.slice(source.indexOf("async function handleRemoteSessions"), source.indexOf("async function handleListPairs"));
  // Server renders 夥伴 without a number; the client fills it from /api/pairs
  // with the same dashboard rules, so the count matches the dashboard.
  assert.match(page, /<a class="pairs-btn" id="pairsBtn" href="\$\{path\("\/pairs"\)\}">夥伴<\/a>/);
  assert.doesNotMatch(page, /pairCount/);
  assert.match(page, /import \{ visiblePairs \} from "\$\{path\(`\/c\/static\/pairs-rules\.js\?v=\$\{pairsRulesHash\}`\)\}"/);
  assert.match(page, /visiblePairs\(pairs, "dashboard"\)\.length/);
  assert.match(page, /fetch\("\$\{basePath\}\/api\/pairs"/);
  // /pairs header links back.
  assert.match(source, /href="\/\?host=mac/);
  const pairsClient = await readFile(new URL("../static/pairs.js", import.meta.url), "utf8");
  assert.match(pairsClient, /sessionsLink\.href = hubHostUrl\(selectedHost\)/);
});

test("api pairs allows cross-origin GET for the aggregate page", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /"Access-Control-Allow-Origin": "\*",/);
  const pairsBlock = source.slice(source.indexOf("async function handleListPairs"), source.indexOf("const PAIR_ACCEPT_PATH_RE"));
  assert.match(pairsBlock, /Access-Control-Allow-Origin/);
  assert.match(source, /req\.url === "\/api\/pairs"\)/);
  assert.match(source, /searchParams\.get\("archived"\) === "1"/);
  assert.match(source, /pairsCache\.get\(archived/);
  assert.match(source, /\/api\/session\/active" \|\| req\.url === "\/api\/pairs"/);
});

test("pairs aggregate mode merges remotes with host tags", async () => {
  const { readFile } = await import("node:fs/promises");
  const client = await readFile(new URL("../static/pairs.js", import.meta.url), "utf8");
  assert.match(client, /opencode-hub:remotes/);
  assert.match(client, /https:\/\/opencode-sara\.sisihome\.org/);
  assert.match(client, /https:\/\/opencode-l390\.sisihome\.org/);
  assert.match(client, /https:\/\/opencode\.sisihome\.org\/sara/);
  assert.match(client, /https:\/\/opencode\.sisihome\.org/);
  assert.match(client, /PAIR_REMOTE_DOMAINS/);
  const hub = await readFile(new URL("../static/hub.html", import.meta.url), "utf8");
  assert.match(hub, /id: "mac"[^\n]+opencode\.sisihome\.org\/sara/);
  assert.match(hub, /id: "l390"[^\n]+opencode\.sisihome\.org\/l390/);
  assert.match(hub, /id: "home"[^\n]+opencode\.sisihome\.org\/home/);
  assert.match(client, /\/api\/pairs/);
  assert.match(client, /host-tag/);
  assert.match(client, /連不上，只顯示其他台/);
  assert.match(client, /location\.hostname === "opencode\.sisihome\.org"/);
});

test("/hub serves the Hub shell without a host-scoped /pairs redirect", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /hubPairsRedirect|hubRedirect/);
  assert.match(source, /handleCompactStatic\(Object\.assign\(req, \{ url: "\/c\/static\/hub\.html" \}\), res\)/);
});

test("Hub exposes shareable tabs, a /pairs link, and top-level prefixed session navigation", async () => {
  const { readFile } = await import("node:fs/promises");
  const hub = await readFile(new URL("../static/hub.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(hub, /href="\/pairs">夥伴<\/a>/);
  assert.match(hub, /history\.pushState\(null, "", hubHostUrl\(active\)\)/);
  assert.match(hub, /parseHubHost\(location\.search, load\(KEY_ACTIVE, "mac"\)\)/);
  assert.match(hub, /frameDocument\?\.addEventListener\("click"/);
  assert.match(source, /href="\$\{nativePath\}" target="_top"/);
  assert.match(source, /href="\$\{compactPath\}" target="_top"/);
  assert.match(hub, /#tabs \{[^}]*min-width: 0;[^}]*overflow-x: auto/s);
  assert.match(hub, /body \{[^}]*overflow: hidden/s);
});

test("pairs cards show owner, model, and labelled context bar", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../static/pairs.js", import.meta.url), "utf8");
  assert.match(client, /派工：\$\{pair\.owner\}/);
  assert.match(client, /<div class="partner">夥伴：\$\{partnerLabel\(pair\)\}<\/div>/);
  assert.match(client, /`模型：\$\{label\}`/);
  assert.match(client, /context \$\{pair\.contextPct\}%/);
  assert.match(client, /對話已用掉模型上限的 \$\{pair\.contextPct\}%/);
  assert.match(client, /ctxbar\$\{over \? " over" : ""\}/);
  assert.match(source, /\.ctxbar\.over > i \{ background: #f59e0b; \}/);
  assert.match(client, /<b><\/b><\/div>/);
});

test("pairs phone dashboard shows a compact partner tag", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../static/pairs.js", import.meta.url), "utf8");
  assert.match(client, /<span class="partner-tag partner-\$\{pair\.partner === "pi" \? "pi" : "opencode"\}">\$\{partnerLabel\(pair\)\}<\/span>/);
  assert.match(source, /\.partner-tag \{ display: none;/);
  assert.match(source, /body\[data-view="dashboard"\] \.partner-tag \{ display: inline-block; \}/);
  assert.match(source, /\.partner-tag\.partner-pi \{ background: var\(--partner-pi-bg\); color: var\(--partner-pi-text\); \}/);
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
