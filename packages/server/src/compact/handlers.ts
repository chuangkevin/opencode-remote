import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
// tsconfig has rootDir=src outDir=dist, so this file ends up at
//   packages/server/dist/compact/handlers.js
// packages/server/static is two levels up from that.
const STATIC_ROOT = join(dirname(__filename), "..", "..", "static");

// Only serve files we explicitly recognize — prevents path traversal.
const ALLOWED: Record<string, string> = {
  "compact.js": "application/javascript; charset=utf-8",
  "compact.css": "text/css; charset=utf-8",
  "marked.min.js": "application/javascript; charset=utf-8",
};

export function handleCompactStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  // strip leading /c/static/
  const filename = url.pathname.replace(/^\/c\/static\//, "");
  const contentType = ALLOWED[filename];
  if (!contentType) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end("Not found");
    return;
  }
  const path = join(STATIC_ROOT, filename);
  if (!existsSync(path)) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end(`File not found at ${path}`);
    return;
  }
  const body = readFileSync(path);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}
