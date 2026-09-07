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

test("session picker requests bounded root sessions without changing the active-session fetch", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(String(url)));
    return Response.json([]);
  };

  try {
    await listSessions();
    await listSessionPickerSessions();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(urls.length, 2);
  assert.equal(urls[0].pathname, "/session");
  assert.equal(urls[0].search, "");
  assert.equal(urls[1].pathname, "/session");
  assert.equal(urls[1].searchParams.get("roots"), "true");
  assert.equal(urls[1].searchParams.get("limit"), "1000");
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
