import type http from "node:http";
import { existsSync } from "node:fs";

function isPromptCreatingPost(req: http.IncomingMessage): boolean {
  if (req.method !== "POST" || !req.url) return false;
  try {
    const pathname = new URL(req.url, "http://opencode-remote.local").pathname;
    return /^\/session\/ses_[A-Za-z0-9]+\/(?:message|prompt_async)$/.test(pathname);
  } catch {
    return false;
  }
}

export function rejectPromptWhileQuiesced(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  markerPath: string | undefined,
): boolean {
  if (!markerPath || !isPromptCreatingPost(req) || !existsSync(markerPath)) return false;

  res.writeHead(503, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Retry-After": "1",
    "X-OpenCode-Remote": "true",
  });
  res.end(JSON.stringify({ error: "OpenCode Remote is updating; retry shortly" }));
  return true;
}
