import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import test from "node:test";

import { getStaticAsset, handleCompactStatic, staticAssetUrl } from "../dist/compact/static-assets.js";
import { encodeHtmlBody, sendHtml } from "../dist/html-response.js";
import {
  isCompressibleUpstreamContentType,
  shouldCompressUpstream,
} from "../dist/proxy-compress.js";

function callStatic(url, { method = "GET", headers = {} } = {}) {
  let status;
  let respHeaders;
  let body;
  const req = { url, method, headers };
  const res = {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      respHeaders = nextHeaders;
    },
    end(nextBody) {
      body = nextBody;
    },
  };
  handleCompactStatic(req, res);
  return { status, headers: respHeaders, body };
}

const asset = () => getStaticAsset("compact.js");

// ── Accept-Encoding: br > gzip > identity ────────────────────────────────────

test("static: prefers br when client accepts br and gzip", () => {
  const { status, headers, body } = callStatic("/c/static/compact.js", {
    headers: { "accept-encoding": "gzip, deflate, br" },
  });
  assert.equal(status, 200);
  assert.equal(headers["Content-Encoding"], "br");
  assert.equal(headers.Vary, "Accept-Encoding");
  assert.ok(headers.ETag);
  assert.deepEqual(brotliDecompressSync(body), asset().content);
});

test("static: serves gzip when client accepts only gzip", () => {
  const { status, headers, body } = callStatic("/c/static/compact.js", {
    headers: { "accept-encoding": "gzip" },
  });
  assert.equal(status, 200);
  assert.equal(headers["Content-Encoding"], "gzip");
  assert.deepEqual(gunzipSync(body), asset().content);
});

test("static: serves identity when client sends no Accept-Encoding", () => {
  const { status, headers, body } = callStatic("/c/static/compact.js", { headers: {} });
  assert.equal(status, 200);
  assert.equal(headers["Content-Encoding"], undefined);
  assert.deepEqual(body, asset().content);
});

// ── 304 ─────────────────────────────────────────────────────────────────────

test("static: If-None-Match matching the ETag returns 304", () => {
  const etag = asset().etag;
  const { status, headers, body } = callStatic("/c/static/compact.js", {
    headers: { "if-none-match": etag },
  });
  assert.equal(status, 304);
  assert.equal(headers.ETag, etag);
  assert.equal(body, undefined);
});

// ── Cache-Control by ?v= ─────────────────────────────────────────────────────

test("static: matching ?v= hash is immutable, missing or wrong ?v= is no-cache", () => {
  const hash = asset().hash;
  const good = callStatic(`/c/static/compact.js?v=${hash}`, { headers: {} });
  assert.equal(good.headers["Cache-Control"], "public, max-age=31536000, immutable");

  const wrong = callStatic("/c/static/compact.js?v=deadbeefcafe", { headers: {} });
  assert.equal(wrong.headers["Cache-Control"], "no-cache");

  const none = callStatic("/c/static/compact.js", { headers: {} });
  assert.equal(none.headers["Cache-Control"], "no-cache");
});

test("static: staticAssetUrl embeds the current content hash", () => {
  assert.equal(staticAssetUrl("compact.js"), `/c/static/compact.js?v=${asset().hash}`);
});

// ── HEAD / 404 / missing headers ─────────────────────────────────────────────

test("static: HEAD returns headers with an empty body", () => {
  const { status, headers, body } = callStatic("/c/static/compact.js", {
    method: "HEAD",
    headers: { "accept-encoding": "gzip" },
  });
  assert.equal(status, 200);
  assert.equal(headers["Content-Encoding"], "gzip");
  assert.ok(Number(headers["Content-Length"]) > 0);
  assert.equal(body, undefined);
});

test("static: unknown file returns 404", () => {
  const { status } = callStatic("/c/static/not-a-real-file.js", { headers: {} });
  assert.equal(status, 404);
});

test("static: tolerates a request object without headers", () => {
  let status;
  let headers;
  let body;
  const res = {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(nextBody) {
      body = nextBody;
    },
  };
  handleCompactStatic({ url: "/c/static/theme.js" }, res);
  assert.equal(status, 200);
  assert.equal(headers["Content-Encoding"], undefined);
  assert.match(body.toString("utf8"), /opencode-color-scheme/);
});

// ── Self-produced HTML compression ───────────────────────────────────────────

test("html-response: gzips when the client accepts gzip, identity otherwise", () => {
  const html = "<!doctype html><html><body>hello</body></html>";
  const gz = encodeHtmlBody({ headers: { "accept-encoding": "gzip" }, method: "GET" }, html);
  assert.equal(gz.contentEncoding, "gzip");
  assert.equal(gunzipSync(gz.body).toString("utf8"), html);

  const plain = encodeHtmlBody({ headers: {}, method: "GET" }, html);
  assert.equal(plain.contentEncoding, undefined);
  assert.equal(plain.body.toString("utf8"), html);
});

test("html-response: sendHtml sets Content-Encoding, Vary and Content-Length", () => {
  let status;
  let headers;
  let body;
  const res = {
    writeHead(nextStatus, nextHeaders) {
      status = nextStatus;
      headers = nextHeaders;
    },
    end(nextBody) {
      body = nextBody;
    },
  };
  sendHtml(
    { method: "GET", headers: { "accept-encoding": "gzip" } },
    res,
    "<!doctype html><html></html>",
    { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  );
  assert.equal(status, 200);
  assert.equal(headers["Content-Encoding"], "gzip");
  assert.equal(headers.Vary, "Accept-Encoding");
  assert.equal(headers["Content-Length"], String(body.byteLength));
});

// ── Upstream /_assets/ compression decisions ─────────────────────────────────

test("proxy-compress: /_assets/ js bundle is compressed (br preferred)", () => {
  const base = {
    method: "GET",
    statusCode: 200,
    upstreamPath: "/_assets/index-abc123.js",
    upstreamContentType: "application/javascript",
  };
  assert.equal(
    shouldCompressUpstream({ ...base, clientAcceptEncoding: "gzip, br" }),
    "br",
  );
  assert.equal(
    shouldCompressUpstream({ ...base, clientAcceptEncoding: "gzip" }),
    "gzip",
  );
  assert.equal(shouldCompressUpstream({ ...base, clientAcceptEncoding: "" }), undefined);
});

test("proxy-compress: never compresses event-stream", () => {
  assert.equal(isCompressibleUpstreamContentType("text/event-stream"), false);
  assert.equal(
    shouldCompressUpstream({
      method: "GET",
      statusCode: 200,
      upstreamPath: "/api/event",
      upstreamContentType: "text/event-stream",
      clientAcceptEncoding: "gzip, br",
    }),
    undefined,
  );
});

test("proxy-compress: skips HEAD, non-200, already-encoded, API paths and images", () => {  const base = {
    statusCode: 200,
    upstreamPath: "/_assets/index-abc123.js",
    upstreamContentType: "application/javascript",
    clientAcceptEncoding: "gzip, br",
  };
  assert.equal(shouldCompressUpstream({ ...base, method: "HEAD" }), undefined);
  assert.equal(shouldCompressUpstream({ ...base, statusCode: 304 }), undefined);
  assert.equal(
    shouldCompressUpstream({ ...base, upstreamContentEncoding: "gzip" }),
    undefined,
  );
  assert.equal(
    shouldCompressUpstream({ ...base, upstreamPath: "/api/session" }),
    undefined,
  );
  assert.equal(
    shouldCompressUpstream({
      ...base,
      upstreamPath: "/_assets/logo.png",
      upstreamContentType: "image/png",
    }),
    undefined,
  );
});

// ── Vary: Accept-Encoding dedupe ─────────────────────────────────────────────

test("proxy vary: does not duplicate Accept-Encoding (case-insensitive)", async () => {
  // dist/index.js starts the proxy on import, so assert on the built source text instead.
  const built = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.match(built, /function appendVaryAcceptEncoding/);
  assert.match(built, /toLowerCase\(\) === "accept-encoding"/);
  assert.match(built, /headers\["vary"\] = appendVaryAcceptEncoding\(headers\["vary"\]\)/);
});
