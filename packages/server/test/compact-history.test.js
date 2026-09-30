import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compactImageSource, prefixCompactImageUrl, prefixMarkdownImageUrls, toolOutputImageParts } from "../static/compact-image.js";
import { truncateLargeSessionValue } from "../dist/session.js";

// compact.js runs against document at import; extract the pure converter by
// slicing its source and evaluating it in a sandbox with stubbed deps.
async function loadConverter() {
  const src = await readFile(new URL("../static/compact.js", import.meta.url), "utf8");
  const start = src.indexOf("// ─── OpenCode 2.x message → compact");
  const end = src.indexOf("function toCompactMessages");
  assert.ok(start >= 0 && end > start);
  const body = src.slice(start, end);
  const fn = new Function("sessionID", "compactImageSource", "BASE_PATH", `${body}; return toCompactMessage;`)("ses_test", compactImageSource, "/sara");
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

test("compact image URL helpers prefix machine paths and reject data URLs without image MIME", () => {
  assert.equal(prefixCompactImageUrl("/file/image.png", "/sara"), "/sara/file/image.png");
  assert.equal(prefixCompactImageUrl("file/image.png", "/sara"), "/sara/file/image.png");
  assert.equal(prefixCompactImageUrl("../file/image.png", "/sara"), "/sara/file/image.png");
  assert.equal(prefixCompactImageUrl("/sara/session/x/file", "/sara"), "/sara/session/x/file");
  assert.equal(prefixCompactImageUrl("https://images.example/a.png", "/sara"), "https://images.example/a.png");
  assert.equal(compactImageSource({ mime: "image/png", data: "YWJj" }, "/sara"), "data:image/png;base64,YWJj");
  assert.equal(compactImageSource({ type: "image", url: "data:;base64,YWJj" }, "/sara"), undefined);
  assert.equal(compactImageSource({ type: "file", mime: "image/jpeg", url: "/file/p.png" }, "/sara"), "/sara/file/p.png");
  assert.equal(prefixMarkdownImageUrls("![photo](/file/photo.png)", "/sara"), "![photo](/sara/file/photo.png)");
  assert.equal(prefixMarkdownImageUrls("![photo](https://images.example/photo.png)", "/sara"), "![photo](https://images.example/photo.png)");
  assert.deepEqual(toolOutputImageParts({ content: [{ type: "image", mimeType: "image/png", data: "YWJj" }] }), [{ type: "image", mimeType: "image/png", data: "YWJj" }]);
});

test("compact history keeps image file/image parts and their machine-prefixed URLs", async () => {
  const toCompactMessage = await loadConverter();
  const user = toCompactMessage({ id: "u1", type: "user", files: [{ mime: "image/png", url: "/file/u.png", name: "u.png" }] });
  assert.deepEqual(user.parts, [{ type: "file", mime: "image/png", url: "/sara/file/u.png", filename: "u.png" }]);
  const assistant = toCompactMessage({ id: "a1", type: "assistant", content: [{ type: "image", mime: "image/jpeg", url: "/session/a1/file/a.jpg" }] });
  assert.deepEqual(assistant.parts, [{ type: "image", mime: "image/jpeg", url: "/sara/session/a1/file/a.jpg", filename: undefined, imageExpected: true }]);
  const missingMime = toCompactMessage({ id: "u2", type: "user", files: [{ data: "YWJj", name: "unknown" }] });
  assert.equal(missingMime.parts[0].imageExpected, true);
  assert.equal(missingMime.parts[0].url, undefined);
  const missingDataMime = toCompactMessage({ id: "u3", type: "user", files: [{ url: "data:;base64,YWJj" }] });
  assert.equal(missingDataMime.parts[0].imageExpected, true);
  assert.equal(missingDataMime.parts[0].url, undefined);
});

test("empty-text user image attachments retain full base64 through session-message sanitization", async () => {
  const data = "A".repeat(600_000);
  const original = {
    data: { messages: [{ type: "user", text: "", files: [{ mime: "image/jpeg", name: "large.jpg", source: { type: "inline" }, data }] }] },
  };
  const stats = { truncated: 0 };
  const sanitized = truncateLargeSessionValue(original, stats);
  assert.equal(stats.truncated, 0);
  assert.equal(sanitized.data.messages[0].files[0].data.length, data.length);

  const toCompactMessage = await loadConverter();
  const compact = toCompactMessage(sanitized.data.messages[0]);
  assert.equal(compact.parts.length, 1);
  assert.equal(compact.parts[0].type, "file");
  assert.equal(compact.parts[0].url, `data:image/jpeg;base64,${data}`);
});

test("session-message sanitizer still truncates oversized non-image tool output", () => {
  const output = "x".repeat(600_000);
  const stats = { truncated: 0 };
  const sanitized = truncateLargeSessionValue({ content: [{ type: "tool", state: { output } }] }, stats);
  assert.equal(stats.truncated, 1);
  assert.ok(sanitized.content[0].state.output.length < output.length);
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
  assert.match(css, /\.msg-body img,[\s\S]*?max-width: 100%;[\s\S]*?height: auto;/);
  assert.match(css, /\.image-load-error/);
  assert.match(css, /\.image-viewer/);
  const src = await readFile(new URL("../static/compact.js", import.meta.url), "utf8");
  assert.match(src, /BASE_PATH === "\/home"\s*\? "https:\/\/opencode-home\.sisihome\.org"/);
  assert.match(src, /圖片載入失敗/);
  assert.match(src, /img\.addEventListener\("click", \(\) => openImageViewer/);
});

test("stop button hidden attribute beats its display rule", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("../static/compact.css", import.meta.url), "utf8");
  assert.match(css, /\.stop-btn\[hidden\] \{ display: none; \}/);
});
