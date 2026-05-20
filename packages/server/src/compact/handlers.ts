import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as appConfig } from "../config.js";
import { renderCompactShell } from "./shell.js";

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

const SESSION_PATH_RE = /^\/c\/session\/(ses_[A-Za-z0-9]+)\/?$/;

export function matchCompactSessionPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const m = SESSION_PATH_RE.exec(path);
  return m ? m[1] : undefined;
}

export function handleCompactSession(sessionID: string, res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-OpenCode-Remote": "compact",
  });
  res.end(renderCompactShell(sessionID));
}

export async function handleCompactNewSession(res: http.ServerResponse): Promise<void> {
  try {
    const r = await fetch(`${appConfig.opencodeUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "compact" }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`OpenCode POST /session returned ${r.status}: ${body.slice(0, 200)}`);
    }
    const session = await r.json() as { id?: string };
    if (!session.id) throw new Error("OpenCode response missing session id");
    res.writeHead(303, {
      Location: `/c/session/${session.id}`,
      "Cache-Control": "no-store",
    });
    res.end();
  } catch (err) {
    console.error("[opencode-remote] /c/new-session failed:", err);
    res.writeHead(502, { "Cache-Control": "no-store" });
    res.end("Failed to create session");
  }
}
