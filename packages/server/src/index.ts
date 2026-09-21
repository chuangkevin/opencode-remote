import http from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import {
  GLOBAL_CONFIG_PATH,
  detectKeyDrift,
  expectedProviderKeys,
  loadedProviderKeys,
  nodeKeyDriftDeps,
} from "./key-drift.js";
import {
  healthRestartCooldownRemainingMs,
  initialHealthWatchdogState,
  nextHealthState,
} from "./health-watchdog.js";
import { RECENT_SESSION_WINDOW_MS, encodeDirSlug, listSessionPickerSessions, mergePinnedSessions, resolveActiveSessionPath } from "./session.js";
import { handleCompactStatic, handleCompactSession, handleCompactNewSession, handleCompactProviders, handleCompactAddProvider, handleLatestUserModel, matchCompactSessionPath, matchLatestUserModelPath } from "./compact/handlers.js";
import { listPins, pinSession, unpinSession } from "./compact/pins.js";
import { ensureSessionTrust } from "./compact/trust.js";
import { handleMergedSessionStatus, isMergedSessionStatusPath, isPathWithinRoot } from "./compact/session-status.js";
import { rejectPromptWhileQuiesced } from "./update-quiesce.js";
import { resolveOpenCodeCommand } from "./opencode-command.js";

// ─── Proxy ───────────────────────────────────────────────────────────────────

const remoteResetScript = `(() => {})();\n`;
const nativeMobileStyle = `<style data-remote-mobile>
@media (max-width: 767px) {
  html { zoom: 1.2; }
  /* 2026-09-21：zoom 1.2 讓 #root 的 100dvh 也被放大 1.2 倍（812px 視窗 → 974px），
     底部輸入列被推到畫面外，要點到輸入框觸發重排才會出現。把高度除回去。 */
  body, #root { height: calc(100dvh / 1.2) !important; }
  [data-component="prompt-input-v2"] [data-component="tooltip-v2-trigger"] { min-width: 0; flex: 0 1 auto; overflow: hidden; }
  [data-component="prompt-input-v2"] [data-action="prompt-model"] { max-width: 100% !important; width: 100%; }
  [data-component="prompt-input-v2"] [data-action="prompt-submit"] { flex-shrink: 0; }
}
</style>`;

const nativePreferencesScript = `<script>(() => {
  const key = "settings.v3";
  const fallback = { general: { newLayoutDesigns: false }, permissions: { autoApprove: true } };
  try {
    const current = JSON.parse(localStorage.getItem(key) || "{}");
    const next = {
      ...current,
      general: { ...(current.general || {}), newLayoutDesigns: false },
      permissions: { ...(current.permissions || {}), autoApprove: true },
    };
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    localStorage.setItem(key, JSON.stringify(fallback));
  }
})();</script>`;

type RemoteDebugEntry = {
  id: number;
  time: string;
  event: string;
  method?: string;
  path?: string;
  upstreamPath?: string;
  status?: number;
  durationMs?: number;
  error?: string;
  version?: string;
  removedCount?: number;
  removed?: string[];
  note?: string;
};

type SessionListEntry = {
  id?: string;
  time?: {
    created?: number;
    updated?: number;
    archived?: number;
  };
};

type SessionStatusMap = Record<string, { type?: string }>;

type OpenCodeMessage = {
  info?: {
    id?: string;
    role?: string;
    modelID?: string;
    providerID?: string;
    time?: {
      created?: number;
      completed?: number;
    };
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
    };
    error?: { name?: string };
  };
  parts?: unknown[];
};

const maxSessionMessageStringLength = 120_000;

const remoteDebugEntries: RemoteDebugEntry[] = [];
let nextRemoteDebugID = 1;

function trimDebugValue(value: unknown, maxLength = 800): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function normalizeDirectory(value: string): string {
  return value.replace(/\\/g, "/");
}

function addRemoteDebugEntry(entry: Omit<RemoteDebugEntry, "id" | "time">): void {
  remoteDebugEntries.push({
    id: nextRemoteDebugID++,
    time: new Date().toISOString(),
    ...entry,
  });
  if (remoteDebugEntries.length > 100) {
    remoteDebugEntries.splice(0, remoteDebugEntries.length - 100);
  }
}

function shouldRecordProxyDebug(path: string | undefined, upstreamPath: string): boolean {
  const values = [path ?? "", upstreamPath];
  return values.some((value) =>
    value === "/session" ||
    value.startsWith("/session?") ||
    value.startsWith("/session/") ||
    value.includes("/session/"),
  );
}

function sessionIDFromReferer(headers: http.IncomingHttpHeaders): string | undefined {
  const referer = Array.isArray(headers.referer) ? headers.referer[0] : headers.referer;
  if (!referer) return undefined;
  try {
    const url = new URL(referer, "http://opencode-remote.local");
    return url.pathname.match(/\/session\/(ses_[^/?#]+)/)?.[1];
  } catch {
    return undefined;
  }
}

function sessionIDFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const url = new URL(path, "http://opencode-remote.local");
    return url.pathname.match(/\/session\/(ses_[^/?#]+)/)?.[1];
  } catch {
    return undefined;
  }
}

function sessionIDFromCookie(headers: http.IncomingHttpHeaders): string | undefined {
  const cookie = Array.isArray(headers.cookie) ? headers.cookie.join("; ") : headers.cookie;
  if (!cookie) return undefined;
  const match = cookie.match(/(?:^|;\s*)opencode_remote_session=([^;]+)/);
  if (!match?.[1]) return undefined;
  try {
    const value = decodeURIComponent(match[1]);
    return value.startsWith("ses_") ? value : undefined;
  } catch {
    return undefined;
  }
}

function appendSetCookie(
  headers: http.OutgoingHttpHeaders,
  value: string,
): void {
  const current = headers["set-cookie"];
  if (Array.isArray(current)) {
    headers["set-cookie"] = [...current, value];
    return;
  }
  if (typeof current === "string") {
    headers["set-cookie"] = [current, value];
    return;
  }
  headers["set-cookie"] = value;
}

function isSessionListRequest(req: http.IncomingMessage, upstreamPath: string): boolean {
  if (req.method !== "GET") return false;
  try {
    return new URL(upstreamPath, config.opencodeUrl).pathname === "/session";
  } catch {
    return false;
  }
}

function isSessionMessageRequest(req: http.IncomingMessage, upstreamPath: string): boolean {
  if (req.method !== "GET") return false;
  try {
    return /^\/session\/ses_[^/]+\/message$/.test(new URL(upstreamPath, config.opencodeUrl).pathname);
  } catch {
    return false;
  }
}

function isImageFileUrl(key: string | undefined, value: string, parent: unknown): boolean {
  if (key !== "url") return false;
  if (!value.startsWith("data:image/")) return false;
  if (!parent || typeof parent !== "object") return false;
  const part = parent as Record<string, unknown>;
  return part.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/");
}

function truncateLargeSessionValue(value: unknown, stats: { truncated: number }, key?: string, parent?: unknown): unknown {
  if (typeof value === "string") {
    if (isImageFileUrl(key, value, parent)) return value;
    if (value.length <= maxSessionMessageStringLength) return value;
    stats.truncated += 1;
    return `${value.slice(0, maxSessionMessageStringLength)}\n\n[opencode-remote: truncated ${value.length - maxSessionMessageStringLength} characters from an oversized session message field]`;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateLargeSessionValue(item, stats));
  }
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      next[key] = truncateLargeSessionValue(item, stats, key, value);
    }
    return next;
  }
  return value;
}

function sanitizeSessionMessageBody(body: Buffer, req: http.IncomingMessage, upstreamPath: string): Buffer {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }

  const stats = { truncated: 0 };
  const sanitized = truncateLargeSessionValue(payload, stats);
  if (stats.truncated === 0) return body;

  addRemoteDebugEntry({
    event: "session-message-truncate",
    method: req.method,
    path: trimDebugValue(req.url),
    upstreamPath: trimDebugValue(upstreamPath),
    note: `truncated ${stats.truncated} oversized field(s)`,
  });
  return Buffer.from(JSON.stringify(sanitized), "utf8");
}

function nativePromptAsyncPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const upstream = new URL(sanitizeProxyPath(path), config.opencodeUrl);
    const match = /^\/session\/(ses_[^/]+)\/message$/.exec(upstream.pathname);
    if (!match) return undefined;
    upstream.pathname = `/session/${match[1]}/prompt_async`;
    return `${upstream.pathname}${upstream.search}`;
  } catch {
    return undefined;
  }
}

async function fetchSessionForList(sessionID: string, upstreamPath: string): Promise<SessionListEntry | undefined> {
  const listUrl = new URL(upstreamPath, config.opencodeUrl);
  const sessionUrl = new URL(`/session/${sessionID}`, config.opencodeUrl);
  for (const key of ["directory", "workspace"]) {
    for (const value of listUrl.searchParams.getAll(key)) {
      sessionUrl.searchParams.append(key, value);
    }
  }

  const res = await fetch(sessionUrl);
  if (!res.ok) return undefined;
  return await res.json() as SessionListEntry;
}

async function preserveCurrentSessionInList(
  body: Buffer,
  req: http.IncomingMessage,
  upstreamPath: string,
): Promise<Buffer> {
  const sessionID = sessionIDFromReferer(req.headers) ?? sessionIDFromCookie(req.headers);
  if (!sessionID) return body;

  let sessions: unknown;
  try {
    sessions = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!Array.isArray(sessions)) return body;

  const list = sessions as SessionListEntry[];
  const maxUpdated = list.reduce((max, session) => Math.max(max, session.time?.updated ?? 0), 0);
  const updated = Math.max(Date.now(), maxUpdated + 1);
  const existing = list.find((session) => session.id === sessionID);

  if (existing) {
    existing.time = { ...existing.time, updated };
    addRemoteDebugEntry({
      event: "session-list-preserve",
      method: req.method,
      path: trimDebugValue(req.url),
      upstreamPath: trimDebugValue(upstreamPath),
      note: `bumped ${sessionID}`,
    });
    return Buffer.from(JSON.stringify(list), "utf8");
  }

  try {
    const session = await fetchSessionForList(sessionID, upstreamPath);
    if (!session?.id) return body;
    session.time = { ...session.time, updated };
    list.push(session);
    addRemoteDebugEntry({
      event: "session-list-preserve",
      method: req.method,
      path: trimDebugValue(req.url),
      upstreamPath: trimDebugValue(upstreamPath),
      note: `appended ${sessionID}`,
    });
    return Buffer.from(JSON.stringify(list), "utf8");
  } catch (err) {
    addRemoteDebugEntry({
      event: "session-list-preserve-error",
      method: req.method,
      path: trimDebugValue(req.url),
      upstreamPath: trimDebugValue(upstreamPath),
      error: err instanceof Error ? err.message : String(err),
    });
    return body;
  }
}

export function injectRemoteReset(html: string): string {
  if (html.includes(nativePreferencesScript)) return html;
  if (html.includes('<script type="module"')) {
    return html.replace('<script type="module"', `${nativeMobileStyle}${nativePreferencesScript}<script type="module"`);
  }
  return html.includes("</head>")
    ? html.replace("</head>", `${nativeMobileStyle}${nativePreferencesScript}</head>`)
    : `${nativeMobileStyle}${nativePreferencesScript}${html}`;
}

function allowInlineScripts(headers: http.OutgoingHttpHeaders, html: string): void {
  const csp = headers["content-security-policy"];
  if (typeof csp !== "string") return;

  const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => `'sha256-${createHash("sha256").update(match[1] ?? "").digest("base64")}'`)
    .filter((hash) => !csp.includes(hash));
  if (hashes.length === 0) return;

  headers["content-security-policy"] = csp.replace(
    /script-src([^;]*)/,
    (match) => `${match} ${hashes.join(" ")}`,
  );
}

function isValidWorkspaceID(value: string): boolean {
  return value.startsWith("wrk");
}

function decodeLegacyDirectorySlug(value: string): string | undefined {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    return decoded && /^[A-Za-z]:[\\/]/.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeProxyPath(path: string | undefined): string {
  if (!path) return "/";

  let url: URL;
  try {
    url = new URL(path, "http://opencode-remote.local");
  } catch {
    return path;
  }

  const workspaces = url.searchParams.getAll("workspace");
  if (workspaces.length === 0 || workspaces.every(isValidWorkspaceID)) {
    return path;
  }

  const legacyDirectory = workspaces.map(decodeLegacyDirectorySlug).find((value) => value !== undefined);
  if (legacyDirectory && !url.searchParams.has("directory")) {
    url.searchParams.set("directory", legacyDirectory);
  }

  url.searchParams.delete("workspace");
  for (const workspace of workspaces.filter(isValidWorkspaceID)) {
    url.searchParams.append("workspace", workspace);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function sanitizeProxyHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = { ...headers };
  delete next["accept-encoding"];

  const workspace = next["x-opencode-workspace"];
  const workspaces = Array.isArray(workspace) ? workspace : workspace === undefined ? [] : [String(workspace)];
  if (workspaces.some((value) => value && !isValidWorkspaceID(value))) {
    delete next["x-opencode-workspace"];
  }
  return next;
}

function sanitizeResponseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = { ...headers, "x-opencode-remote": "true" };
  for (const header of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    delete next[header];
  }
  return next;
}

function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const upstreamPath = sanitizeProxyPath(req.url);
  const debugRequest = shouldRecordProxyDebug(req.url, upstreamPath);
  const retryableRequest = debugRequest && (req.method === "GET" || req.method === "HEAD");
  const debugStartedAt = Date.now();
  let debugLogged = false;

  const logProxyDebug = (entry: Pick<RemoteDebugEntry, "status" | "error" | "note">): void => {
    if (!debugRequest || debugLogged) return;
    debugLogged = true;
    addRemoteDebugEntry({
      event: "proxy",
      method: req.method,
      path: trimDebugValue(req.url),
      upstreamPath: trimDebugValue(upstreamPath),
      durationMs: Date.now() - debugStartedAt,
      ...entry,
    });
  };

  const options: http.RequestOptions = {
    hostname: "127.0.0.1",
    port: config.opencodePort,
    path: upstreamPath,
    method: req.method,
    headers: {
      ...sanitizeProxyHeaders(req.headers),
      host: `127.0.0.1:${config.opencodePort}`,
    },
  };

  let proxyReq: http.ClientRequest;
  let proxyRes: http.IncomingMessage | undefined;
  let cleanedUp = false;
  let retried = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let proxyAttempt = 0;

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (retryTimer) clearTimeout(retryTimer);
    proxyReq.destroy();
    proxyRes?.destroy();
  };

  const retryProxyRequest = (err: Error): boolean => {
    if (!retryableRequest || retried || cleanedUp || res.headersSent || res.destroyed) return false;
    retried = true;
    addRemoteDebugEntry({
      event: "proxy-retry",
      method: req.method,
      path: trimDebugValue(req.url),
      upstreamPath: trimDebugValue(upstreamPath),
      durationMs: Date.now() - debugStartedAt,
      error: err.message,
      note: "retrying safe request once",
    });
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (cleanedUp || res.destroyed) return;
      startProxyRequest(false);
    }, 150);
    return true;
  };

  const startProxyRequest = (pipeBody: boolean): void => {
    const attemptID = ++proxyAttempt;
    proxyReq = http.request(options, (upstreamRes) => {
      proxyRes = upstreamRes;
      logProxyDebug({ status: upstreamRes.statusCode });
      if (cleanedUp || res.destroyed) {
        upstreamRes.destroy();
        return;
      }

      const isHead = req.method === "HEAD";

      upstreamRes.on("error", (err) => {
        if (retryProxyRequest(err)) return;
        if (!res.destroyed) res.destroy();
      });

      const headers = sanitizeResponseHeaders(upstreamRes.headers);
      if (isHead && headers["content-length"] === "0") {
        delete headers["content-length"];
      }

      // Static bundles under /assets/ use content-hashed filenames
      // (e.g. index-B-ada5Lh.js) but upstream sends no Cache-Control, so
      // browsers re-download the ~2.5MB JS bundle on every visit. Hashed
      // names change when content changes, so immutable caching is safe
      // and makes repeat loads of the standard session UI near-instant.
      if (upstreamPath.startsWith("/assets/") && (upstreamRes.statusCode ?? 200) === 200) {
        headers["cache-control"] = "public, max-age=31536000, immutable";
      }

      const contentType = upstreamRes.headers["content-type"];
      const isHtml = !isHead && typeof contentType === "string" && contentType.includes("text/html");
      const isJsonSessionList = !isHead &&
        typeof contentType === "string" &&
        contentType.includes("application/json") &&
        isSessionListRequest(req, upstreamPath);
      const isJsonSessionMessage = !isHead &&
        typeof contentType === "string" &&
        contentType.includes("application/json") &&
        isSessionMessageRequest(req, upstreamPath);
      if (isHtml) {
        delete headers["content-length"];
        delete headers["content-encoding"];
        headers["cache-control"] = "no-store, no-cache, must-revalidate";
        headers["pragma"] = "no-cache";
        const pageSessionID = sessionIDFromPath(upstreamPath);
        if (pageSessionID) {
          ensureSessionTrust(config.opencodeUrl, pageSessionID).catch((err) => {
            addRemoteDebugEntry({
              event: "native-trust-error",
              method: req.method,
              path: trimDebugValue(req.url),
              upstreamPath: `/session/${pageSessionID}`,
              status: 502,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          appendSetCookie(
            headers,
            `opencode_remote_session=${encodeURIComponent(pageSessionID)}; Path=/; Max-Age=3600; SameSite=Lax; HttpOnly`,
          );
        }
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        upstreamRes.on("end", () => {
          if (res.destroyed || cleanedUp) return;
          const sendPage = (): void => {
            if (res.destroyed || cleanedUp) return;
            const html = injectRemoteReset(Buffer.concat(chunks).toString("utf8"));
            allowInlineScripts(headers, html);
            const body = Buffer.from(html, "utf8");
            headers["content-length"] = String(body.byteLength);
            res.writeHead(upstreamRes.statusCode ?? 200, headers);
            res.end(body);
          };
          // opencode returns the SPA shell (200) for any /session/<id> URL
          // even when the session no longer exists (e.g. a deleted session);
          // the client then dead-ends on a "Session not found" 404 error
          // screen with no way back. Verify existence server-side and, if the
          // session is gone, redirect to root so the app recovers to the
          // session list / most-recent session instead of the dead screen.
          if (pageSessionID) {
            fetch(`${config.opencodeUrl}/session/${pageSessionID}`, { method: "GET" })
              .then((r) => {
                if (res.destroyed || cleanedUp) return;
                if (r.status === 404) {
                  res.writeHead(302, {
                    location: "/",
                    "cache-control": "no-store, no-cache, must-revalidate",
                  });
                  res.end();
                  return;
                }
                sendPage();
              })
              .catch(() => sendPage());
            return;
          }
          sendPage();
        });
        return;
      }

      if (isJsonSessionList) {
        delete headers["content-length"];
        delete headers["content-encoding"];
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        upstreamRes.on("end", () => {
          if (res.destroyed || cleanedUp) return;
          void preserveCurrentSessionInList(Buffer.concat(chunks), req, upstreamPath).then((body) => {
            if (res.destroyed || cleanedUp) return;
            headers["content-length"] = String(body.byteLength);
            res.writeHead(upstreamRes.statusCode ?? 200, headers);
            res.end(body);
          });
        });
        return;
      }

      if (isJsonSessionMessage) {
        delete headers["content-length"];
        delete headers["content-encoding"];
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk: Buffer | string) => {
          if (attemptID !== proxyAttempt) return;
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        upstreamRes.on("end", () => {
          if (attemptID !== proxyAttempt || res.destroyed || cleanedUp) return;
          const body = sanitizeSessionMessageBody(Buffer.concat(chunks), req, upstreamPath);
          headers["content-length"] = String(body.byteLength);
          res.writeHead(upstreamRes.statusCode ?? 200, headers);
          res.end(body);
        });
        return;
      }

      res.writeHead(upstreamRes.statusCode ?? 200, headers);
      upstreamRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      if (retryProxyRequest(err)) return;
      logProxyDebug({ status: 502, error: err.message });
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502);
        res.end("Bad Gateway");
      }
    });

    if (pipeBody) {
      req.pipe(proxyReq, { end: true });
      return;
    }
    proxyReq.end();
  };

  req.on("aborted", cleanup);
  req.on("close", () => {
    if (!req.complete) cleanup();
  });
  res.on("close", () => {
    if (!res.writableEnded) cleanup();
  });

  startProxyRequest(true);
}

function proxyNativePromptAsync(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamPath: string,
): void {
  const startedAt = Date.now();
  let logged = false;
  const log = (entry: Pick<RemoteDebugEntry, "status" | "error" | "note">): void => {
    if (logged) return;
    logged = true;
    addRemoteDebugEntry({
      event: "native-prompt-async",
      method: req.method,
      path: trimDebugValue(req.url),
      upstreamPath: trimDebugValue(upstreamPath),
      durationMs: Date.now() - startedAt,
      ...entry,
    });
  };

  const upstreamReq = http.request({
    hostname: "127.0.0.1",
    port: config.opencodePort,
    path: upstreamPath,
    method: "POST",
    headers: {
      ...sanitizeProxyHeaders(req.headers),
      host: `127.0.0.1:${config.opencodePort}`,
    },
  }, (upstreamRes) => {
    log({ status: upstreamRes.statusCode, note: "rewrote native prompt to prompt_async" });
    const headers = sanitizeResponseHeaders(upstreamRes.headers);

    if ((upstreamRes.statusCode ?? 500) >= 200 && (upstreamRes.statusCode ?? 500) < 300) {
      upstreamRes.resume();
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(upstreamRes.statusCode ?? 204, headers);
        res.end();
      }
      return;
    }

    if (!res.headersSent && !res.destroyed) {
      res.writeHead(upstreamRes.statusCode ?? 502, headers);
      upstreamRes.pipe(res, { end: true });
    } else {
      upstreamRes.resume();
    }
  });

  upstreamReq.on("error", (err) => {
    log({ status: 502, error: err.message });
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(502, { "Cache-Control": "no-store", "X-OpenCode-Remote": "true" });
      res.end("Bad Gateway");
    }
  });

  req.pipe(upstreamReq, { end: true });
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

let activeSessionPath = "";

const serviceWorkerCleanup = `self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),
    self.registration.unregister(),
    self.clients.claim(),
  ]));
});

self.addEventListener("fetch", () => {});
`;

function sendServiceWorkerCleanup(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "Service-Worker-Allowed": "/",
    "X-OpenCode-Remote": "true",
  });
  res.end(serviceWorkerCleanup);
}

function sendRemoteResetScript(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "X-OpenCode-Remote": "true",
  });
  res.end(remoteResetScript);
}

function sendRemoteDebugJson(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-OpenCode-Remote": "true",
  });
  res.end(JSON.stringify({ entries: remoteDebugEntries }, null, 2));
}

function handleRemoteDebug(res: http.ServerResponse): void {
  const rows = [...remoteDebugEntries].reverse().map((entry) => {
    const details = entry.removed?.length ? entry.removed.join("\n") : "";
    return `<tr>
      <td>${entry.id}</td>
      <td>${escapeHtml(new Date(entry.time).toLocaleString("zh-TW"))}</td>
      <td>${escapeHtml(entry.event)}</td>
      <td>${escapeHtml(entry.method ?? "")}</td>
      <td>${escapeHtml(entry.status === undefined ? "" : String(entry.status))}</td>
      <td>${escapeHtml(entry.durationMs === undefined ? "" : `${entry.durationMs}ms`)}</td>
      <td><code>${escapeHtml(entry.path ?? "")}</code></td>
      <td><code>${escapeHtml(entry.upstreamPath ?? "")}</code></td>
      <td>${escapeHtml(entry.error ?? "")}</td>
      <td>${escapeHtml(entry.version ?? "")}</td>
      <td>${escapeHtml(entry.note ?? "")}</td>
      <td>${escapeHtml(entry.removedCount === undefined ? "" : String(entry.removedCount))}</td>
      <td><pre>${escapeHtml(details)}</pre></td>
    </tr>`;
  }).join("");

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-OpenCode-Remote": "true",
  });
  res.end(`<!doctype html>
    <html lang="zh-Hant">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0f0f10" />
        <script>(()=>{let p="system";try{const s=localStorage.getItem("opencode-color-scheme");if(["light","dark","system"].includes(s))p=s}catch{}try{const t=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;const r=document.documentElement;r.dataset.themePreference=p;r.dataset.theme=t;r.style.colorScheme=t;const m=document.querySelector('meta[name="theme-color"]');if(m)m.content=t==="light"?"#f7f7f5":"#0f0f10"}catch{}})()</script>
        <title>OpenCode Remote Debug</title>
        <style>
          :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --bg: #09090b; --surface: #18181b; --border: #27272a; --text: #f4f4f5; --muted: #a1a1aa; --link: #93c5fd; }
          :root[data-theme="light"] { color-scheme: light; --bg: #f7f7f5; --surface: #ffffff; --border: #d7d7d2; --text: #202023; --muted: #5f6068; --link: #1d4ed8; }
          * { box-sizing: border-box; }
          body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); overflow-x: hidden; }
          .page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
          h1 { flex: 1; font-size: 18px; margin: 0; }
          p { margin: 0 0 16px; color: var(--muted); font-size: 13px; }
          a { color: var(--link); }
          .theme-toggle { width: 44px; height: 44px; flex: 0 0 44px; border: 1px solid var(--border); border-radius: 50%; background: var(--surface); color: var(--text); font: inherit; font-size: 17px; cursor: pointer; }
          .wrap { width: 100%; overflow-x: auto; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
          table { width: 100%; border-collapse: collapse; min-width: 1200px; }
          th, td { border-bottom: 1px solid var(--border); padding: 8px 10px; text-align: left; vertical-align: top; font-size: 12px; }
          th { position: sticky; top: 0; background: var(--surface); color: var(--text); }
          code, pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
          pre { margin: 0; }
          @media (max-width: 767px) { body { padding: 10px; } .page-head { margin-bottom: 4px; } }
        </style>
      </head>
      <body>
        <div class="page-head"><h1>OpenCode Remote Debug</h1><button class="theme-toggle" type="button" data-theme-toggle aria-label="切換配色"></button></div>
        <p>Recent session/API and browser reset events only. Prompt bodies are not recorded. JSON: <a href="/remote-debug.json">/remote-debug.json</a></p>
        <div class="wrap">
          <table>
            <thead>
              <tr>
                <th>ID</th><th>Time</th><th>Event</th><th>Method</th><th>Status</th><th>Duration</th>
                <th>Path</th><th>Upstream Path</th><th>Error</th><th>Version</th><th>Note</th><th>Removed</th><th>Removed Keys</th>
              </tr>
            </thead>
            <tbody>${rows || `<tr><td colspan="13">No debug entries yet.</td></tr>`}</tbody>
          </table>
        </div>
        <script type="module" src="/c/static/theme.js"></script>
      </body>
    </html>`);
}

function handleRemoteClientDebug(req: http.IncomingMessage, res: http.ServerResponse): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;

  req.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 16_384) {
      tooLarge = true;
      return;
    }
    chunks.push(buffer);
  });

  req.on("end", () => {
    if (tooLarge) {
      addRemoteDebugEntry({ event: "client-debug-error", status: 413, error: "payload too large" });
      res.writeHead(413, { "Cache-Control": "no-store", "X-OpenCode-Remote": "true" });
      res.end();
      return;
    }

    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const removed = Array.isArray(payload.removed)
        ? payload.removed.map((value) => trimDebugValue(value, 240) ?? "").filter(Boolean).slice(0, 30)
        : undefined;
      const entry: Omit<RemoteDebugEntry, "id" | "time"> = {
        event: trimDebugValue(payload.event, 80) ?? "client-debug",
        path: trimDebugValue(payload.path),
        version: trimDebugValue(payload.version, 120),
      };
      if (typeof payload.error === "string") entry.error = trimDebugValue(payload.error);
      if (removed) {
        entry.removedCount = Array.isArray(payload.removed) ? payload.removed.length : removed.length;
        entry.removed = removed;
      }
      addRemoteDebugEntry(entry);
    } catch (err) {
      addRemoteDebugEntry({
        event: "client-debug-error",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    res.writeHead(204, { "Cache-Control": "no-store", "X-OpenCode-Remote": "true" });
    res.end();
  });

  req.on("error", (err) => {
    addRemoteDebugEntry({ event: "client-debug-error", error: err.message });
    if (!res.headersSent) res.writeHead(400, { "Cache-Control": "no-store", "X-OpenCode-Remote": "true" });
    res.end();
  });
}

function redirectToSession(res: http.ServerResponse, sessionPath: string): void {
  res.writeHead(302, {
    Location: sessionPath,
    "Cache-Control": "no-store",
    "X-OpenCode-Remote": "true",
  });
  res.end();
}

async function handleRemoteHealth(res: http.ServerResponse): Promise<void> {
  try {
    const healthRes = await fetch(`${config.opencodeUrl}/global/health`);
    const upstreamHealth = await healthRes.json();

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-OpenCode-Remote": "true",
    });
    res.end(JSON.stringify({
      proxy: "opencode-remote",
      remotePort: config.port,
      upstream: config.opencodeUrl,
      upstreamHealth,
    }, null, 2));
  } catch (err) {
    res.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-OpenCode-Remote": "true",
    });
    res.end(JSON.stringify({
      proxy: "opencode-remote",
      remotePort: config.port,
      upstream: config.opencodeUrl,
      error: err instanceof Error ? err.message : String(err),
    }, null, 2));
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

type RemoteSessionsWindow = "3d" | "30d" | "all";

function parseRemoteSessionsWindow(req: http.IncomingMessage): RemoteSessionsWindow {
  try {
    const window = new URL(req.url ?? "/remote-sessions", "http://opencode-remote.local").searchParams.get("window");
    return window === "30d" || window === "all" ? window : "3d";
  } catch {
    return "3d";
  }
}

function remoteSessionsWindowLabel(window: RemoteSessionsWindow): string {
  if (window === "30d") return "30 天內";
  if (window === "all") return "全部";
  return "3 天內";
}

function remoteSessionsEmptyMessage(window: RemoteSessionsWindow): string {
  if (window === "30d") return "30 天內沒有工作階段";
  if (window === "all") return "沒有工作階段";
  return "3 天內沒有工作階段";
}

function remoteSessionsNextWindow(window: RemoteSessionsWindow): RemoteSessionsWindow | undefined {
  if (window === "3d") return "30d";
  if (window === "30d") return "all";
  return undefined;
}

function remoteSessionsLoadMoreLabel(nextWindow: RemoteSessionsWindow | undefined): string {
  if (nextWindow === "30d") return "載入更多（30 天）";
  if (nextWindow === "all") return "載入全部";
  return "已載入全部";
}

async function handleRemoteSessions(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const windowKey = parseRemoteSessionsWindow(req);
    const now = Date.now();
    const sessionOptions = windowKey === "all"
      ? { limit: 1000 }
      : {
          sinceMs: now - (windowKey === "30d" ? 10 * RECENT_SESSION_WINDOW_MS : RECENT_SESSION_WINDOW_MS),
        };
    const [allSessions, pinnedIds] = await Promise.all([
      listSessionPickerSessions(sessionOptions),
      listPins(),
    ]);
    const pinnedSet = new Set(pinnedIds);
    const ordered = await mergePinnedSessions(allSessions, pinnedIds);
    const windowLabel = remoteSessionsWindowLabel(windowKey);
    const nextWindow = remoteSessionsNextWindow(windowKey);
    const loadMoreLabel = remoteSessionsLoadMoreLabel(nextWindow);

    const items = ordered.map((session) => {
      const nativePath = `/${encodeDirSlug(session.directory)}/session/${session.id}`;
      const compactPath = `/c/session/${session.id}`;
      const title = session.title || session.slug || session.id;
      const pinned = pinnedSet.has(session.id);
      const pinClass = pinned ? "pin-btn pinned" : "pin-btn";
      const pinLabel = pinned ? "取消釘選" : "釘選";
      const directoryAttribute = isPathWithinRoot(session.directory, config.opencodeDirectory)
        ? ` data-session-directory="${escapeHtml(session.directory)}"`
        : "";
      return `<div class="session${pinned ? " is-pinned" : ""}" data-session-id="${session.id}"${directoryAttribute}>
        <button class="${pinClass}" type="button" data-pin-toggle="${session.id}" data-pinned="${pinned ? "1" : "0"}" aria-label="${pinLabel}" title="${pinLabel}">📌</button>
        <a class="session-link" href="${nativePath}">
          <strong><span class="running-indicator" hidden title="執行中" aria-label="執行中" role="img"></span><span class="session-title">${escapeHtml(title)}</span></strong>
          <small>${escapeHtml(formatTime(session.time.updated))}</small>
        </a>
        <a class="compact-btn" href="${compactPath}" title="開啟 compact 視圖">Compact</a>
      </div>`;
    }).join("");

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-OpenCode-Remote": "true",
    });
    res.end(`<!doctype html>
      <html lang="zh-Hant">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <meta name="theme-color" content="#0f0f10" />
          <script>(()=>{let p="system";try{const s=localStorage.getItem("opencode-color-scheme");if(["light","dark","system"].includes(s))p=s}catch{}try{const t=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;const r=document.documentElement;r.dataset.themePreference=p;r.dataset.theme=t;r.style.colorScheme=t;const m=document.querySelector('meta[name="theme-color"]');if(m)m.content=t==="light"?"#f7f7f5":"#0f0f10"}catch{}})()</script>
          <script>(()=>{let v;try{const s=localStorage.getItem("opencode-font-scale");v=["1","1.15","1.3","1.45"].includes(s)?s:(matchMedia("(max-width: 767px)").matches?"1.3":"1")}catch{v="1"}try{document.documentElement.style.setProperty("--font-scale",v)}catch{}})()</script>
          <title>OpenCode Sessions</title>
          <style>
            :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --bg: #0f0f10; --surface: #18181b; --surface-hi: #1f1f23; --header-bg: rgba(15,15,16,.94); --border: #27272a; --text: #f4f4f5; --muted: #71717a; --accent: #6366f1; --accent-active: #4f46e5; --pinned-bg: #1a1827; --pinned-border: #4338ca; --pill-bg: #312e81; --pill-text: #c7d2fe; --running: #22c55e; --running-glow: rgba(34,197,94,.16); --running-glow-wide: rgba(34,197,94,.1); --font-scale: 1; }
            :root[data-theme="light"] { color-scheme: light; --bg: #f7f7f5; --surface: #ffffff; --surface-hi: #f0f0ed; --header-bg: rgba(247,247,245,.94); --border: #d7d7d2; --text: #202023; --muted: #686970; --accent: #4f46e5; --accent-active: #4338ca; --pinned-bg: #eeecff; --pinned-border: #8179e7; --pill-bg: #e8e7ff; --pill-text: #3730a3; --running: #15803d; --running-glow: rgba(21,128,61,.18); --running-glow-wide: rgba(21,128,61,.12); }
            * { box-sizing: border-box; }
            body { margin: 0; background: var(--bg); color: var(--text); padding: max(8px, env(safe-area-inset-top)) 10px max(14px, env(safe-area-inset-bottom)); font-size: calc(14px * var(--font-scale)); line-height: 1.4; overflow-x: hidden; }
            header { position: sticky; top: 0; z-index: 1; margin: -8px -10px 8px; padding: 6px 12px; min-height: 52px; background: var(--header-bg); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
            h1 { font-size: 15px; font-weight: 600; margin: 0; flex: 1; }
            .window-label { color: var(--muted); font-size: 12px; font-weight: 500; margin-left: 3px; }
            .new-btn { min-height: 44px; background: var(--accent); color: #fff; border: none; border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; text-decoration: none; line-height: 1; }
            .new-btn:active { background: var(--accent-active); }
            .load-more-btn { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 44px; margin-top: 8px; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 999px; padding: 8px 14px; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
            .load-more-btn:active { background: var(--surface-hi); }
            .load-more-btn:disabled { cursor: default; opacity: .65; }
            .load-more-btn[hidden] { display: none; }
            .theme-toggle, .font-scale-toggle { width: 44px; height: 44px; flex: 0 0 44px; border: 1px solid var(--border); border-radius: 50%; background: var(--surface); color: var(--text); font: inherit; font-size: 17px; cursor: pointer; }
            .session { position: relative; padding: 8px 10px 8px 46px; min-height: 52px; margin-bottom: 4px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
            .session:active { background: var(--surface-hi); }
            .session.is-pinned { border-color: var(--pinned-border); background: var(--pinned-bg); }
            .pin-btn { position: absolute; top: 50%; left: 2px; transform: translateY(-50%); width: 44px; height: 44px; padding: 0; background: none; border: 0; cursor: pointer; opacity: 0.35; font-size: 13px; line-height: 1; color: inherit; filter: grayscale(1); }
            .pin-btn.pinned { opacity: 1; filter: none; }
            .pin-btn:active { transform: translateY(-50%) scale(0.92); }
            .session-link { display: flex; align-items: baseline; gap: 8px; color: inherit; text-decoration: none; padding-right: 76px; min-width: 0; }
            .session-link strong { display: flex; align-items: center; gap: 7px; flex: 1; font-size: calc(13.5px * var(--font-scale)); font-weight: 500; line-height: 1.3; min-width: 0; color: var(--text); }
            .session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
            .running-indicator { width: 8px; height: 8px; flex: 0 0 8px; border-radius: 50%; background: var(--running); box-shadow: 0 0 0 2px var(--running-glow); animation: running-pulse 1.8s ease-in-out infinite; }
            .running-indicator[hidden] { display: none; }
            @keyframes running-pulse { 0%, 100% { opacity: .65; } 50% { opacity: 1; box-shadow: 0 0 0 4px var(--running-glow-wide); } }
            @media (prefers-reduced-motion: reduce) { .running-indicator { animation: none; } }
            .session-link small { flex-shrink: 0; font-size: calc(11px * var(--font-scale)); color: var(--muted); font-weight: normal; }
            .compact-btn { position: absolute; top: 50%; right: 4px; transform: translateY(-50%); display: inline-flex; align-items: center; min-height: 44px; font-size: 11px; font-weight: 500; padding: 4px 10px; border-radius: 999px; background: var(--pill-bg); color: var(--pill-text); border: 1px solid var(--pinned-border); text-decoration: none; line-height: 1; }
            .compact-btn:active { background: var(--accent-active); color: #fff; }
            .empty { padding: 24px 12px; color: var(--muted); font-size: calc(13px * var(--font-scale)); text-align: center; }
            @media (max-width: 767px) { header { gap: 4px; } .session-link { gap: 5px; padding-right: 82px; } .session-link small { display: none; } }
            @media (min-width: 768px) and (max-width: 1023px) { body { padding-inline: 16px; } header { margin-inline: -16px; } }
          </style>
        </head>
        <body data-window="${windowKey}">
          <header>
            <h1>工作階段<span class="window-label">（${windowLabel}）</span></h1>
            <button class="font-scale-toggle" type="button" data-font-scale-cycle aria-label="切換字級">Aa</button>
            <button class="theme-toggle" type="button" data-theme-toggle aria-label="切換配色"></button>
            <form method="post" action="/c/new-session" style="margin:0;">
              <button class="new-btn" type="submit">+ 新</button>
            </form>
          </header>
          <div id="sessionList">${items || `<div class="empty">${remoteSessionsEmptyMessage(windowKey)}</div>`}</div>
          <button class="load-more-btn" type="button" data-next-window="${nextWindow ?? ""}"${nextWindow ? "" : " hidden disabled"}>${loadMoreLabel}</button>
          <script>
            document.addEventListener("click", async function (e) {
              const btn = e.target.closest("[data-pin-toggle]");
              if (!btn) return;
              e.preventDefault();
              e.stopPropagation();
              const id = btn.dataset.pinToggle;
              const wasPinned = btn.dataset.pinned === "1";
              btn.disabled = true;
              try {
                const r = await fetch("/c/pins/" + id, { method: wasPinned ? "DELETE" : "POST" });
                if (!r.ok) throw new Error("pin toggle failed: " + r.status);
                // Re-fetch the page to get the canonical sort order so the
                // user immediately sees the pinned item bubble up.
                window.location.reload();
              } catch (err) {
                btn.disabled = false;
                console.error(err);
                alert("釘選操作失敗：" + err.message);
              }
            });
          </script>
          <script type="module" src="/c/static/font-scale.js"></script>
          <script type="module" src="/c/static/theme.js"></script>
          <script type="module" src="/c/static/remote-sessions.js"></script>
        </body>
      </html>`);
  } catch (err) {
    console.error("[opencode-remote] failed to render remote sessions:", err);
    res.writeHead(500, { "Cache-Control": "no-store" });
    res.end("Failed to load sessions");
  }
}

async function handleListPins(res: http.ServerResponse): Promise<void> {
  try {
    const ids = await listPins();
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-OpenCode-Remote": "true",
    });
    res.end(JSON.stringify(ids));
  } catch (err) {
    console.error("[opencode-remote] listPins failed:", err);
    res.writeHead(500, { "Cache-Control": "no-store" });
    res.end("Failed to list pins");
  }
}

async function handlePinSession(id: string, res: http.ServerResponse): Promise<void> {
  try {
    await pinSession(id);
    res.writeHead(204, { "Cache-Control": "no-store", "X-OpenCode-Remote": "true" });
    res.end();
  } catch (err) {
    console.error(`[opencode-remote] pin ${id} failed:`, err);
    res.writeHead(500, { "Cache-Control": "no-store" });
    res.end("Failed to pin");
  }
}

async function handleUnpinSession(id: string, res: http.ServerResponse): Promise<void> {
  try {
    await unpinSession(id);
    res.writeHead(204, { "Cache-Control": "no-store", "X-OpenCode-Remote": "true" });
    res.end();
  } catch (err) {
    console.error(`[opencode-remote] unpin ${id} failed:`, err);
    res.writeHead(500, { "Cache-Control": "no-store" });
    res.end("Failed to unpin");
  }
}

function sendCompactMockup(res: http.ServerResponse): void {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // dist/index.js → repo root is ../../../..  (packages/server/dist → repo)
  const mockupPath = join(__dirname, "..", "..", "..", "mockups", "compact-mockup.html");
  try {
    const html = readFileSync(mockupPath, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
  } catch (err) {
    console.error("[opencode-remote] failed to read compact mockup:", err);
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end(`Mockup not found at ${mockupPath}`);
  }
}

function handleRootRedirect(res: http.ServerResponse): void {
  redirectToSession(res, "/remote-sessions");
}

async function handleLatestRedirect(res: http.ServerResponse): Promise<void> {
  try {
    activeSessionPath = await resolveActiveSessionPath();
    redirectToSession(res, activeSessionPath);
    return;
  } catch (err) {
    console.error("[opencode-remote] failed to resolve active session for /latest:", err);
  }

  if (!activeSessionPath) {
    res.writeHead(503, { "Cache-Control": "no-store" });
    res.end("Starting up - please wait and refresh");
    return;
  }

  redirectToSession(res, activeSessionPath);
}

const server = http.createServer((req, res) => {
  if (rejectPromptWhileQuiesced(req, res, config.updateQuiesceFile)) return;

  if (req.method === "GET" && req.url === "/remote-health") {
    void handleRemoteHealth(res);
    return;
  }

  if (req.method === "GET" && req.url === "/sw.js") {
    sendServiceWorkerCleanup(res);
    return;
  }

  if (req.method === "GET" && req.url === "/remote-reset.js") {
    sendRemoteResetScript(res);
    return;
  }

  if (req.method === "GET" && req.url === "/remote-debug") {
    handleRemoteDebug(res);
    return;
  }

  if (req.method === "GET" && req.url === "/remote-debug.json") {
    sendRemoteDebugJson(res);
    return;
  }

  if (req.method === "POST" && req.url === "/remote-client-debug") {
    handleRemoteClientDebug(req, res);
    return;
  }

  if (req.method === "GET" && req.url && new URL(req.url, "http://opencode-remote.local").pathname === "/remote-sessions") {
    void handleRemoteSessions(req, res);
    return;
  }

  if (req.method === "GET" && isMergedSessionStatusPath(req.url)) {
    void handleMergedSessionStatus(req, res, {
      ownOrigin: config.opencodeUrl,
      allowedRoot: config.opencodeDirectory,
    });
    return;
  }

  if (req.method === "GET" && req.url === "/c-mockup") {
    sendCompactMockup(res);
    return;
  }

  if (req.method === "GET") {
    const latestUserModelSessionID = matchLatestUserModelPath(req.url);
    if (latestUserModelSessionID) {
      void handleLatestUserModel(latestUserModelSessionID, res);
      return;
    }
    const compactSessionID = matchCompactSessionPath(req.url);
    if (compactSessionID) {
      handleCompactSession(compactSessionID, res);
      return;
    }
  }

  if (req.method === "GET" && req.url?.startsWith("/c/static/")) {
    handleCompactStatic(req, res);
    return;
  }

  if (req.url === "/c/providers") {
    if (req.method === "GET" || req.method === "HEAD") {
      void handleCompactProviders(res);
      return;
    }
    if (req.method === "POST") {
      void handleCompactAddProvider(req, res);
      return;
    }
  }

  if (req.method === "POST" && req.url === "/c/new-session") {
    void handleCompactNewSession(res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && req.url === "/c/pins") {
    void handleListPins(res);
    return;
  }
  const pinMatch = /^\/c\/pins\/(ses_[A-Za-z0-9]+)\/?$/.exec(req.url ?? "");
  if (pinMatch) {
    if (req.method === "POST") {
      void handlePinSession(pinMatch[1], res);
      return;
    }
    if (req.method === "DELETE") {
      void handleUnpinSession(pinMatch[1], res);
      return;
    }
  }

  if ((req.method === "GET" || req.method === "HEAD") && req.url === "/") {
    handleRootRedirect(res);
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && req.url === "/latest") {
    void handleLatestRedirect(res);
    return;
  }

  if (req.method === "POST") {
    const asyncPromptPath = nativePromptAsyncPath(req.url);
    if (asyncPromptPath) {
      proxyNativePromptAsync(req, res, asyncPromptPath);
      return;
    }
  }

  proxy(req, res);
});

// ─── Dead stream watchdog ────────────────────────────────────────────────────

const deadStreamAbortAttempts = new Map<string, number>();

async function fetchBusySessionIDs(directory: string): Promise<string[]> {
  const url = new URL("/session/status", config.opencodeUrl);
  url.searchParams.set("directory", normalizeDirectory(directory));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET /session/status returned ${res.status}`);
  const statuses = await res.json() as SessionStatusMap;
  return Object.entries(statuses)
    .filter(([, status]) => status?.type === "busy")
    .map(([sessionID]) => sessionID);
}

async function fetchRecentMessages(sessionID: string): Promise<OpenCodeMessage[]> {
  const url = new URL(`/session/${sessionID}/message`, config.opencodeUrl);
  url.searchParams.set("limit", "8");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET /session/${sessionID}/message returned ${res.status}`);
  const messages = await res.json() as unknown;
  return Array.isArray(messages) ? messages as OpenCodeMessage[] : [];
}

function lastMessage(messages: OpenCodeMessage[]): OpenCodeMessage | undefined {
  return [...messages]
    .sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0))
    .at(-1);
}

function isZeroOutputDeadStream(message: OpenCodeMessage | undefined, now: number): boolean {
  const info = message?.info;
  if (!info) return false;
  if (info.role !== "assistant") return false;
  if (info.time?.completed) return false;
  if (info.error?.name) return false;
  const created = info.time?.created ?? 0;
  if (!created || now - created < config.deadStreamWatchdogMinAgeMs) return false;
  if ((message.parts?.length ?? 0) !== 0) return false;
  const tokens = info.tokens;
  const tokenCount = (tokens?.input ?? 0) + (tokens?.output ?? 0) + (tokens?.reasoning ?? 0);
  return tokenCount === 0;
}

async function abortDeadStream(sessionID: string, message: OpenCodeMessage, now: number): Promise<void> {
  const messageID = message.info?.id ?? "unknown";
  const lastAttempt = deadStreamAbortAttempts.get(messageID) ?? 0;
  if (now - lastAttempt < 300_000) return;
  deadStreamAbortAttempts.set(messageID, now);

  const res = await fetch(`${config.opencodeUrl}/session/${sessionID}/abort`, { method: "POST" });
  if (!res.ok) throw new Error(`POST /session/${sessionID}/abort returned ${res.status}`);

  const ageSeconds = Math.round((now - (message.info?.time?.created ?? now)) / 1_000);
  addRemoteDebugEntry({
    event: "dead-stream-abort",
    path: `/session/${sessionID}`,
    status: res.status,
    note: `${messageID} age=${ageSeconds}s model=${message.info?.providerID}/${message.info?.modelID}`,
  });
  console.warn(`[opencode-remote] aborted dead stream ${sessionID}/${messageID} after ${ageSeconds}s`);
}

async function checkDeadStreams(): Promise<void> {
  const now = Date.now();
  const busySessionIDs = await fetchBusySessionIDs(config.opencodeDirectory);
  for (const sessionID of busySessionIDs) {
    try {
      const message = lastMessage(await fetchRecentMessages(sessionID));
      if (!message) continue;
      if (!isZeroOutputDeadStream(message, now)) continue;
      await abortDeadStream(sessionID, message, now);
    } catch (err) {
      addRemoteDebugEntry({
        event: "dead-stream-watchdog-error",
        path: `/session/${sessionID}`,
        error: err instanceof Error ? err.message : String(err),
      });
      console.warn(`[opencode-remote] dead stream watchdog failed for ${sessionID}:`, err);
    }
  }

  if (deadStreamAbortAttempts.size > 200) {
    const cutoff = now - 3_600_000;
    for (const [messageID, timestamp] of deadStreamAbortAttempts) {
      if (timestamp < cutoff) deadStreamAbortAttempts.delete(messageID);
    }
  }
}

function startDeadStreamWatchdog(): void {
  if (!config.deadStreamWatchdogEnabled) {
    console.log("[opencode-remote] dead stream watchdog disabled");
    return;
  }
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await checkDeadStreams();
    } catch (err) {
      console.warn("[opencode-remote] dead stream watchdog failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => { void tick(); }, 15_000);
  setInterval(() => { void tick(); }, config.deadStreamWatchdogIntervalMs);
  console.log(
    `[opencode-remote] dead stream watchdog enabled: interval=${config.deadStreamWatchdogIntervalMs}ms minAge=${config.deadStreamWatchdogMinAgeMs}ms`,
  );
}

// ─── Keep-alive SSE client ───────────────────────────────────────────────────

function startKeepAlive(): void {
  let delay = 1_000;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let connect: () => void;

  const scheduleReconnect = (): void => {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };

  connect = (): void => {
    const req = http.get(
      `${config.opencodeUrl}/event`,
      { headers: { Accept: "text/event-stream" } },
      (res) => {
        delay = 1_000;
        res.on("data", () => { /* consume to keep stream open */ });
        res.on("end", scheduleReconnect);
        res.on("error", () => {
          delay = Math.min(delay * 2, 30_000);
          scheduleReconnect();
        });
      },
    );
    req.on("error", () => {
      delay = Math.min(delay * 2, 30_000);
      scheduleReconnect();
    });
  };

  connect();
}

// ─── Startup ─────────────────────────────────────────────────────────────────

const startupTerminationGraceMs = 3_000;
const startupKillWaitMs = 2_000;

function spawnOpenCode(): ChildProcess {
  console.log(`[opencode-remote] spawning opencode serve in ${config.opencodeDirectory}`);
  const opencodeCmd = resolveOpenCodeCommand({
    explicitPath: process.env.OPENCODE_CLI_PATH,
    localAppData: process.env.LOCALAPPDATA ?? "",
  });
  return spawn(
    opencodeCmd,
    ["serve", "--hostname", "127.0.0.1", "--port", String(config.opencodePort)],
    {
      cwd: config.opencodeDirectory,
      stdio: "inherit",
      shell: false,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: "" },
    },
  );
}

async function waitForOpenCode(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${config.opencodeUrl}/global/health`);
      const json = (await res.json()) as { healthy?: boolean };
      if (json.healthy) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error("OpenCode did not become healthy within 60 seconds");
}

async function probeOpenCodeHealth(timeoutMs: number): Promise<boolean> {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetch(`${config.opencodeUrl}/global/health`, { signal: abort.signal });
    if (res.status !== 200) return false;
    const json = (await res.json()) as { healthy?: boolean };
    return json.healthy === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateOpenCodeChild(child: ChildProcess, context: string): Promise<void> {
  if (childHasExited(child)) return;

  await new Promise<void>((resolve) => {
    let forceKillTimer: NodeJS.Timeout | undefined;
    let killWaitTimer: NodeJS.Timeout | undefined;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (killWaitTimer) clearTimeout(killWaitTimer);
      child.off("exit", finish);
      resolve();
    };

    child.once("exit", finish);
    if (childHasExited(child)) {
      finish();
      return;
    }

    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (!childHasExited(child)) {
        console.error(`[opencode-remote] OpenCode did not stop after ${context}; sending SIGKILL`);
        child.kill("SIGKILL");
      }
      killWaitTimer = setTimeout(() => {
        if (!childHasExited(child)) {
          console.error(`[opencode-remote] OpenCode is still running after ${context} SIGKILL`);
        }
        finish();
      }, startupKillWaitMs);
    }, startupTerminationGraceMs);
  });
}

async function refreshSessionPath(): Promise<void> {
  try {
    activeSessionPath = await resolveActiveSessionPath();
    console.log(`[opencode-remote] active session path: ${activeSessionPath}`);
  } catch (err) {
    console.error("[opencode-remote] failed to resolve active session:", err);
  }
}

async function main(): Promise<void> {
  // 1. Spawn OpenCode headless server
  let oc = spawnOpenCode();
  let shuttingDown = false;
  let restartingChild = false;
  let restartingChildRef: ChildProcess | undefined;
  let ownsOpenCodeProcess = true;

  const cleanupOpenCodeAfterStartupFailure = async (): Promise<void> => {
    if (process.platform === "win32") return;

    shuttingDown = true;
    await terminateOpenCodeChild(oc, "startup failure");
  };

  const attachOpenCodeExitHandler = (child: ChildProcess): void => {
    child.on("exit", async (code) => {
      if (shuttingDown) return;
      if (restartingChildRef && child === restartingChildRef) return;
      if (child !== oc) return;
      console.error(`[opencode-remote] opencode exited with code ${code}`);
      // If another OpenCode is already healthy on this port, don't crash.
      try {
        const r = await fetch(`${config.opencodeUrl}/global/health`);
        const j = (await r.json()) as { healthy?: boolean };
        if (j.healthy) {
          ownsOpenCodeProcess = false;
          console.log("[opencode-remote] existing OpenCode instance is healthy; continuing");
          return;
        }
      } catch { /* fall through */ }
      process.exit(1);
    });
  };
  attachOpenCodeExitHandler(oc);

  const fetchLoadedProviderKeys = async (): Promise<Map<string, string>> => {
    const res = await fetch(`${config.opencodeUrl}/config`);
    if (!res.ok) throw new Error(`GET /config returned ${res.status}`);
    return loadedProviderKeys(await res.json());
  };

  const currentKeyDrift = async (): Promise<string[]> => {
    const expected = expectedProviderKeys(readFileSync(GLOBAL_CONFIG_PATH, "utf8"), nodeKeyDriftDeps);
    return detectKeyDrift(expected, await fetchLoadedProviderKeys());
  };

  const restartOpenCodeChild = async (reason: string): Promise<void> => {
    if (restartingChild) throw new Error("opencode restart already in progress");
    restartingChild = true;
    const previous = oc;
    restartingChildRef = previous;
    try {
      await terminateOpenCodeChild(previous, `${reason} restart`);
      oc = spawnOpenCode();
      attachOpenCodeExitHandler(oc);

      try {
        await waitForOpenCode();
      } catch (err) {
        await terminateOpenCodeChild(oc, `failed ${reason} restart`);
        console.error("[opencode-remote] fatal:", err);
        process.exit(1);
      }
    } finally {
      restartingChild = false;
      restartingChildRef = undefined;
    }
  };

  function startKeyDriftWatchdog(): void {
    if (config.keyDriftIntervalMs <= 0) {
      console.log("[opencode-remote] key drift watchdog disabled");
      return;
    }

    let running = false;
    let lastDriftRestartAt = 0;
    const tick = async (): Promise<void> => {
      if (running || restartingChild) return;
      running = true;
      try {
        const drift = await currentKeyDrift();
        if (drift.length === 0) return;

        if (!ownsOpenCodeProcess) {
          console.warn("[opencode-remote] provider apiKey drift detected but this proxy does not own the opencode process");
          return;
        }

        const now = Date.now();
        const elapsed = now - lastDriftRestartAt;
        if (lastDriftRestartAt > 0 && elapsed < config.keyDriftRestartCooldownMs) {
          const waitSeconds = Math.ceil((config.keyDriftRestartCooldownMs - elapsed) / 1_000);
          console.warn(`[opencode-remote] provider apiKey drift detected; restart cooldown active for ${waitSeconds}s`);
          return;
        }

        lastDriftRestartAt = now;
        console.warn(
          `[opencode-remote] provider apiKey changed on disk (ids: ${drift.join(", ")}); restarting opencode serve`,
        );
        await restartOpenCodeChild("key drift");
        const remainingDrift = await currentKeyDrift();
        if (remainingDrift.length > 0) {
          throw new Error(`provider keys still differ after restart: ${remainingDrift.join(", ")}`);
        }
        console.log("[opencode-remote] opencode serve restarted; provider keys now match");
      } catch (err) {
        console.warn("[opencode-remote] key drift watchdog failed:", err);
      } finally {
        running = false;
      }
    };

    setTimeout(() => { void tick(); }, 15_000);
    setInterval(() => { void tick(); }, config.keyDriftIntervalMs);
    console.log(
      `[opencode-remote] key drift watchdog enabled: interval=${config.keyDriftIntervalMs}ms cooldown=${config.keyDriftRestartCooldownMs}ms`,
    );
  }

  function startHealthWatchdog(): void {
    if (config.healthWatchdogIntervalMs <= 0) {
      console.log("[opencode-remote] health watchdog disabled");
      return;
    }

    let running = false;
    let state = initialHealthWatchdogState();
    const opts = {
      failures: config.healthWatchdogFailures,
      restartCooldownMs: config.healthWatchdogRestartCooldownMs,
    };

    const tick = async (): Promise<void> => {
      if (running || restartingChild) return;
      running = true;
      try {
        const probeOk = await probeOpenCodeHealth(config.healthWatchdogTimeoutMs);
        const result = nextHealthState(state, probeOk, Date.now(), opts);
        state = result.state;

        if (result.action === "recovered") {
          console.warn("[opencode-remote] opencode serve health recovered");
          return;
        }

        if (result.action === "cooldown") {
          const waitSeconds = Math.ceil(healthRestartCooldownRemainingMs(state, Date.now(), opts) / 1_000);
          console.warn(`[opencode-remote] opencode serve unresponsive; restart cooldown active for ${waitSeconds}s`);
          return;
        }

        if (result.action !== "restart") return;

        const failures = Math.max(1, config.healthWatchdogFailures);
        if (!ownsOpenCodeProcess) {
          console.warn(
            `[opencode-remote] opencode serve unresponsive (${failures} consecutive health probe failures) but this proxy does not own the opencode process`,
          );
          state = initialHealthWatchdogState();
          return;
        }

        console.warn(
          `[opencode-remote] opencode serve unresponsive (${failures} consecutive health probe failures); restarting`,
        );
        await restartOpenCodeChild("health watchdog");
        console.warn("[opencode-remote] opencode serve restarted by health watchdog");
      } catch (err) {
        console.warn("[opencode-remote] health watchdog failed:", err);
      } finally {
        running = false;
      }
    };

    setInterval(() => { void tick(); }, config.healthWatchdogIntervalMs);
    console.log(
      `[opencode-remote] health watchdog enabled: interval=${config.healthWatchdogIntervalMs}ms timeout=${config.healthWatchdogTimeoutMs}ms failures=${config.healthWatchdogFailures} cooldown=${config.healthWatchdogRestartCooldownMs}ms`,
    );
  }

  if (process.platform !== "win32") {
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`[opencode-remote] received ${signal}; stopping proxy and OpenCode`);

      let childExited = childHasExited(oc);
      let serverClosed = !server.listening;
      const forceExit = setTimeout(() => {
        console.error("[opencode-remote] shutdown timed out after 5 seconds");
        if (!childHasExited(oc)) oc.kill("SIGKILL");
        process.exit(1);
      }, 5_000);
      forceExit.unref();

      const finishIfStopped = (): void => {
        if (!childExited || !serverClosed) return;
        clearTimeout(forceExit);
        process.exit(0);
      };

      if (!childExited) {
        oc.once("exit", () => {
          childExited = true;
          finishIfStopped();
        });
        oc.kill(signal);
      }

      if (!serverClosed) {
        server.close(() => {
          serverClosed = true;
          finishIfStopped();
        });
      }

      finishIfStopped();
    };

    process.once("SIGTERM", () => shutdown("SIGTERM"));
    process.once("SIGINT", () => shutdown("SIGINT"));
  }

  try {
    // 2. Wait for OpenCode to be healthy
    console.log("[opencode-remote] waiting for OpenCode to be ready...");
    await waitForOpenCode();
    console.log("[opencode-remote] OpenCode is ready");

    // 3. Resolve initial active session path
    await refreshSessionPath();

    // 4. Periodically refresh the active session path
    setInterval(() => { void refreshSessionPath(); }, config.sessionRefreshIntervalMs);

    // 5. Keep-alive SSE connection to OpenCode
    startKeepAlive();

    // 6. Auto-clear OpenCode streams that produced no output and never completed.
    startDeadStreamWatchdog();

    // 7. Restart owned OpenCode child when provider apiKey values change on disk.
    startKeyDriftWatchdog();

    // 8. Restart owned OpenCode child when health probes stop responding.
    startHealthWatchdog();

    // 9. Start HTTP proxy server
    await new Promise<void>((resolve, reject) => {
      const onStartupError = (err: Error): void => reject(err);
      server.once("error", onStartupError);
      server.listen(config.port, config.bindAddress, () => {
        server.off("error", onStartupError);
        console.log(`[opencode-remote] proxy listening on http://${config.bindAddress}:${config.port}`);
        console.log("[opencode-remote] → redirecting / to /remote-sessions");
        console.log(`[opencode-remote] → redirecting /latest to ${activeSessionPath}`);
        resolve();
      });
    });
  } catch (err) {
    await cleanupOpenCodeAfterStartupFailure();
    throw err;
  }
}

main().catch((err) => {
  console.error("[opencode-remote] fatal:", err);
  process.exit(1);
});
