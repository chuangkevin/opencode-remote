import assert from "node:assert/strict";
import test from "node:test";

import {
  getSession,
  listSessions,
  listSessionPickerSessions,
  mergePinnedSessions,
} from "../dist/session.js";

function session(id, updated, parentID) {
  return {
    id,
    slug: id,
    projectID: "project",
    ...(parentID ? { parentID } : {}),
    directory: "/workspace",
    title: id,
    time: { created: updated, updated },
  };
}

test("session APIs use the 2.x /api/session list with Basic auth and unwrap { data }", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  const auth = [];
  globalThis.fetch = async (url, init) => {
    urls.push(new URL(String(url)));
    auth.push(new Headers(init?.headers).get("authorization"));
    return Response.json({ data: [
      { id: "ses_new", projectID: "p", title: "new", location: { directory: "/w" }, time: { created: 1, updated: 200 } },
      { id: "ses_old", projectID: "p", title: "old", location: { directory: "/w" }, time: { created: 1, updated: 100 } },
    ] });
  };

  let all;
  let windowed;
  try {
    await listSessions();
    all = await listSessionPickerSessions();
    windowed = await listSessionPickerSessions({ sinceMs: 150 });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(urls.length, 3);
  assert.equal(urls[0].pathname, "/api/session");
  assert.equal(urls[0].searchParams.get("limit"), "20");
  assert.equal(urls[0].searchParams.get("parentID"), "null");
  assert.equal(urls[1].pathname, "/api/session");
  assert.equal(urls[1].searchParams.get("limit"), "200");
  assert.equal(urls[1].searchParams.get("order"), "desc");
  assert.ok(auth.every((value) => typeof value === "string" && value.startsWith("Basic ")));
  // 2.x has no `start` filter: the window is applied locally on time.updated.
  assert.deepEqual(all.map((s) => s.id), ["ses_new", "ses_old"]);
  assert.deepEqual(windowed.map((s) => s.id), ["ses_new"]);
  // location.directory is surfaced as the 1.x-style `directory` field.
  assert.equal(all[0].directory, "/w");
});

test("recovers missing pins, deduplicates present pins, and orders pins first", async () => {
  const recent = session("ses_recent", 30);
  const presentPin = session("ses_present", 10);
  const recoveredPin = session("ses_recovered", 20);
  const requested = [];

  const merged = await mergePinnedSessions(
    [recent, presentPin],
    ["ses_present", "ses_recovered", "ses_present"],
    async (id) => {
      requested.push(id);
      return recoveredPin;
    },
  );

  assert.deepEqual(requested, ["ses_recovered"]);
  assert.deepEqual(merged.map(({ id }) => id), [
    "ses_recovered",
    "ses_present",
    "ses_recent",
  ]);
});

test("recovers at most twenty missing pinned sessions", async () => {
  const requested = [];
  const pinnedIds = Array.from({ length: 25 }, (_, index) => `ses_pin_${index}`);

  const merged = await mergePinnedSessions([], pinnedIds, async (id) => {
    requested.push(id);
    return session(id, requested.length);
  });

  assert.equal(requested.length, 20);
  assert.deepEqual(requested, pinnedIds.slice(0, 20));
  assert.equal(merged.length, 20);
});

test("single-session lookup treats only 404 as absent", async () => {
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal(await getSession("ses_stale"), undefined);
    assert.deepEqual(
      (await mergePinnedSessions([session("ses_current", 1)], ["ses_stale"])).map(({ id }) => id),
      ["ses_current"],
    );

    globalThis.fetch = async () => new Response(null, { status: 503 });
    await assert.rejects(getSession("ses_failed"), /returned 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resolveActiveSessionPath returns the 2.x /server/<key>/session route", async () => {
  const { encodeServerKey, requestOrigin, resolveActiveSessionPath } = await import("../dist/session.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ data: [
      { id: "ses_abc123", projectID: "p", title: "t", location: { directory: "/w" }, time: { created: 1, updated: 100 } },
    ] });
  try {
    // Key is base64url(origin), verified against the L390 production URL.
    assert.equal(
      encodeServerKey("https://opencode-l390.sisihome.org"),
      "aHR0cHM6Ly9vcGVuY29kZS1sMzkwLnNpc2lob21lLm9yZw",
    );
    const path = await resolveActiveSessionPath("https://opencode-sara.sisihome.org");
    assert.match(path, /^\/server\/[A-Za-z0-9_-]+\/session\/ses_abc123$/);
    assert.equal(
      path,
      `/server/${encodeServerKey("https://opencode-sara.sisihome.org")}/session/ses_abc123`,
    );
    // x-forwarded headers win; no host falls back to undefined.
    assert.equal(
      requestOrigin({ headers: { "x-forwarded-proto": "https", "x-forwarded-host": "opencode-sara.sisihome.org" } }),
      "https://opencode-sara.sisihome.org",
    );
    assert.equal(
      requestOrigin({ headers: { host: "127.0.0.1:9299" }, socket: {} }),
      "http://127.0.0.1:9299",
    );
    assert.equal(requestOrigin({ headers: {} }), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote-sessions cards and compact link the 2.x /server/ route", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /\/server\/\$\{encodeServerKey\(origin\)\}\/session\/\$\{session\.id\}/);
  const compact = await readFile(new URL("../static/compact.js", import.meta.url), "utf8");
  assert.match(compact, /\/server\/\$\{key\}\/session\/\$\{sessionID\}/);
  assert.match(compact, /btoa\(location\.origin\)/);
});
