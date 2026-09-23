import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
// tsconfig has rootDir=src outDir=dist, so this file ends up at
//   packages/server/dist/compact/static-assets.js
// packages/server/static is two levels up from that.
const STATIC_ROOT = join(dirname(__filename), "..", "..", "static");

// Only serve files we explicitly recognize — prevents path traversal.
export const STATIC_ALLOWED: Record<string, string> = {
  "compact.js": "application/javascript; charset=utf-8",
  "compact-model.js": "application/javascript; charset=utf-8",
  "compact.css": "text/css; charset=utf-8",
  "marked.min.js": "application/javascript; charset=utf-8",
  "remote-sessions.js": "application/javascript; charset=utf-8",
  "hub.html": "text/html; charset=utf-8",
  "theme.js": "application/javascript; charset=utf-8",
  "font-scale.js": "application/javascript; charset=utf-8",
};

type CachedAsset = {
  mtimeMs: number;
  content: Buffer;
  hash: string;
  etag: string;
  gzip: Buffer;
  br: Buffer;
  contentType: string;
};

const cache = new Map<string, CachedAsset>();

export function getStaticAsset(filename: string): CachedAsset | undefined {
  const contentType = STATIC_ALLOWED[filename];
  if (!contentType) return undefined;
  const path = join(STATIC_ROOT, filename);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = cache.get(filename);
  if (hit && hit.mtimeMs === mtimeMs) return hit;
  let content: Buffer;
  try {
    content = readFileSync(path);
  } catch {
    return undefined;
  }
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const entry: CachedAsset = {
    mtimeMs,
    content,
    hash,
    etag: `"${hash}"`,
    gzip: gzipSync(content),
    br: brotliCompressSync(content),
    contentType,
  };
  cache.set(filename, entry);
  return entry;
}

export function staticAssetUrl(name: string): string {
  const asset = getStaticAsset(name);
  if (!asset) return `/c/static/${name}`;
  return `/c/static/${name}?v=${asset.hash}`;
}

function requestHeader(req: http.IncomingMessage, name: string): string {
  const value = req.headers?.[name];
  if (Array.isArray(value)) return value.join(", ");
  return value ?? "";
}

export function handleCompactStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  // strip leading /c/static/
  const filename = url.pathname.replace(/^\/c\/static\//, "");
  const asset = getStaticAsset(filename);
  if (!asset) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end("Not found");
    return;
  }
  const method = (req.method ?? "GET").toUpperCase();
  const v = url.searchParams.get("v");
  const cacheControl = v !== null && v === asset.hash
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  const ifNoneMatch = requestHeader(req, "if-none-match");
  if (ifNoneMatch.trim() === "*" || (ifNoneMatch !== "" && ifNoneMatch.includes(asset.hash))) {
    res.writeHead(304, {
      ETag: asset.etag,
      "Cache-Control": cacheControl,
      Vary: "Accept-Encoding",
    });
    res.end();
    return;
  }
  const acceptEncoding = requestHeader(req, "accept-encoding").toLowerCase();
  let body: Buffer = asset.content;
  let contentEncoding: string | undefined;
  if (acceptEncoding.includes("br")) {
    body = asset.br;
    contentEncoding = "br";
  } else if (acceptEncoding.includes("gzip")) {
    body = asset.gzip;
    contentEncoding = "gzip";
  }
  const headers: http.OutgoingHttpHeaders = {
    "Content-Type": asset.contentType,
    "Cache-Control": cacheControl,
    ETag: asset.etag,
    Vary: "Accept-Encoding",
    "Content-Length": String(body.byteLength),
  };
  if (contentEncoding) headers["Content-Encoding"] = contentEncoding;
  if (method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}
