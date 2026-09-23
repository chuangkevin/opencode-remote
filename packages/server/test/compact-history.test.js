import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// compact.js runs against document at import; extract the pure converter by
// slicing its source and evaluating it in a sandbox with stubbed deps.
async function loadConverter() {
  const src = await readFile(new URL("../static/compact.js", import.meta.url), "utf8");
  const start = src.indexOf("// ─── OpenCode 2.x message → compact");
  const end = src.indexOf("function toCompactMessages");
  assert.ok(start >= 0 && end > start);
  const body = src.slice(start, end);
  const fn = new Function("sessionID", `${body}; return toCompactMessage;`)("ses_test");
  return fn;
}

test("idle outcomes map to dividers (interrupted/failed) or nothing (succeeded)", async () => {
  const toCompactMessage = await loadConverter();
  assert.deepEqual(
    toCompactMessage({ id: "m1", type: "idle", outcome: "interrupted", time: { created: 1 } }),
    { info: { id: "m1", divider: "已中斷", time: { created: 1 } } },
  );
  assert.deepEqual(
    toCompactMessage({ id: "m2", type: "idle", outcome: "failed", time: { created: 2 } }),
    { info: { id: "m2", divider: "失敗", time: { created: 2 }, failedIdle: true } },
  );
  assert.equal(toCompactMessage({ id: "m3", type: "idle", outcome: "succeeded" }), null);
  assert.equal(toCompactMessage({ id: "m4", type: "idle" }), null);
});

test("assistant error becomes a red error part; empty assistant stays convertible", async () => {
  const toCompactMessage = await loadConverter();
  const withErr = toCompactMessage({
    id: "a1", type: "assistant", content: [],
    error: { type: "aborted", message: "Step interrupted" },
  });
  assert.deepEqual(withErr.parts, [{ type: "error", errorType: "aborted", text: "Step interrupted" }]);
  const empty = toCompactMessage({ id: "a2", type: "assistant", content: [] });
  assert.deepEqual(empty.parts, []);
});

test("model-switched and synthetic become grey divider lines", async () => {
  const toCompactMessage = await loadConverter();
  const sw = toCompactMessage({
    id: "s1", type: "model-switched",
    model: { id: "cc/x/y" }, previous: { id: "pair/a/b" },
  });
  assert.equal(sw.info.divider, "已切換模型：pair/a/b → cc/x/y");
  const syn = toCompactMessage({ id: "s2", type: "synthetic", text: "The previous response was interrupted." });
  assert.equal(syn.info.divider, "The previous response was interrupted.");
  assert.equal(toCompactMessage({ id: "s3", type: "synthetic", text: "" }), null);
});

test("compact reconciles streaming state against /api/session/active", async () => {
  const src = await readFile(new URL("../static/compact.js", import.meta.url), "utf8");
  assert.match(src, /ACTIVE_RECONCILE_MS = 15_000/);
  assert.match(src, /refreshBusyStatus/);
});

test("compact styles dividers and error lines", async () => {
  const css = await readFile(new URL("../static/compact.css", import.meta.url), "utf8");
  assert.match(css, /\.msg\.divider/);
  assert.match(css, /\.divider-line::before/);
  assert.match(css, /\.msg-error/);
  assert.match(css, /\.divider-error/);
});
