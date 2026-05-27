import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { encodeDirSlug, isUserSession, listSessions, resolveActiveSessionPath } from "./session.js";
import { handleCompactStatic, handleCompactSession, handleCompactNewSession, matchCompactSessionPath } from "./compact/handlers.js";
import { listPins, pinSession, unpinSession } from "./compact/pins.js";

// ─── Proxy ───────────────────────────────────────────────────────────────────

const remoteResetScript = `(() => {
  const version = "2026-05-27-native-loader-v1";
  const marker = "opencode-remote.reset-version";

  const report = (payload) => {
    try {
      const body = JSON.stringify(Object.assign({
        version,
        path: location.pathname + location.search,
      }, payload));
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/remote-client-debug", new Blob([body], { type: "application/json" }));
        return;
      }
      fetch("/remote-client-debug", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch {}
  };

  const shouldRemove = (key) =>
    key === "layout.page.v1" ||
    key === "opencode.global.dat" ||
    key === "opencode.global.dat:layout.page" ||
    key.startsWith("opencode.global.dat:layout.") ||
    key.startsWith("opencode.workspace.");

  const removeMatching = (storage, name) => {
    const removed = [];
    try {
      for (const key of Object.keys(storage)) {
        if (shouldRemove(key)) {
          storage.removeItem(key);
          removed.push(name + ":" + key);
        }
      }
    } catch (err) {
      report({ event: "reset-error", storage: name, error: err instanceof Error ? err.message : String(err) });
    }
    return removed;
  };

  try {
    if (localStorage.getItem(marker) === version) {
      report({ event: "reset-skip" });
      return;
    }

    const removed = removeMatching(localStorage, "localStorage").concat(removeMatching(sessionStorage, "sessionStorage"));

    if ("caches" in window) {
      caches.keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .catch(() => {});
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
        .catch(() => {});
    }

    localStorage.setItem(marker, version);
    report({ event: "reset-applied", removed });

    if (sessionStorage.getItem(marker + ".reload") !== version) {
      sessionStorage.setItem(marker + ".reload", version);
      location.reload();
    }
  } catch (err) {
    report({ event: "reset-error", error: err instanceof Error ? err.message : String(err) });
  }
})();
`;

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

function injectRemoteReset(html: string): string {
  const script = `<script src="/remote-reset.js"></script>`;
  if (html.includes(script)) return html;
  if (html.includes('<script type="module"')) {
    return html.replace('<script type="module"', `${script}<script type="module"`);
  }
  return html.includes("</head>")
    ? html.replace("</head>", `${script}</head>`)
    : `${script}${html}`;
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
        const pageSessionID = sessionIDFromPath(upstreamPath);
        if (pageSessionID) {
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
          const body = Buffer.from(injectRemoteReset(Buffer.concat(chunks).toString("utf8")), "utf8");
          headers["content-length"] = String(body.byteLength);
          res.writeHead(upstreamRes.statusCode ?? 200, headers);
          res.end(body);
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
          const body = Buffer.concat(chunks);
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
        <title>OpenCode Remote Debug</title>
        <style>
          :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
          body { margin: 0; padding: 16px; background: #09090b; color: #f4f4f5; }
          h1 { font-size: 18px; margin: 0 0 8px; }
          p { margin: 0 0 16px; color: #a1a1aa; font-size: 13px; }
          a { color: #93c5fd; }
          .wrap { overflow-x: auto; border: 1px solid #27272a; border-radius: 12px; }
          table { width: 100%; border-collapse: collapse; min-width: 1200px; }
          th, td { border-bottom: 1px solid #27272a; padding: 8px 10px; text-align: left; vertical-align: top; font-size: 12px; }
          th { position: sticky; top: 0; background: #18181b; color: #d4d4d8; }
          code, pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
          pre { margin: 0; }
        </style>
      </head>
      <body>
        <h1>OpenCode Remote Debug</h1>
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

async function handleRemoteSessions(res: http.ServerResponse): Promise<void> {
  try {
    const [allSessions, pinnedIds] = await Promise.all([
      listSessions(),
      listPins(),
    ]);
    const pinnedSet = new Set(pinnedIds);
    const filtered = allSessions.filter(isUserSession);
    // Pinned first (each group sorted by recency); pinned references that no
    // longer correspond to a real session are silently dropped here — we do
    // not auto-prune the file, the next pin/unpin write rewrites it anyway.
    const pinnedSessions = filtered
      .filter((s) => pinnedSet.has(s.id))
      .sort((a, b) => b.time.updated - a.time.updated);
    const otherSessions = filtered
      .filter((s) => !pinnedSet.has(s.id))
      .sort((a, b) => b.time.updated - a.time.updated);
    const ordered = [...pinnedSessions, ...otherSessions];

    const items = ordered.map((session) => {
      const nativePath = `/${encodeDirSlug(session.directory)}/session/${session.id}`;
      const compactPath = `/c/session/${session.id}`;
      const title = session.title || session.slug || session.id;
      const pinned = pinnedSet.has(session.id);
      const pinClass = pinned ? "pin-btn pinned" : "pin-btn";
      const pinLabel = pinned ? "取消釘選" : "釘選";
      return `<div class="session${pinned ? " is-pinned" : ""}" data-session-id="${session.id}">
        <button class="${pinClass}" type="button" data-pin-toggle="${session.id}" data-pinned="${pinned ? "1" : "0"}" aria-label="${pinLabel}" title="${pinLabel}">📌</button>
        <a class="session-link" href="${nativePath}">
          <strong>${escapeHtml(title)}</strong>
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
          <title>OpenCode Sessions</title>
          <style>
            :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
            * { box-sizing: border-box; }
            body { margin: 0; background: #0f0f10; color: #f4f4f5; padding: max(8px, env(safe-area-inset-top)) 10px max(14px, env(safe-area-inset-bottom)); font-size: 14px; line-height: 1.4; }
            header { position: sticky; top: 0; z-index: 1; margin: -8px -10px 8px; padding: 10px 12px; background: rgba(15,15,16,.94); backdrop-filter: blur(12px); border-bottom: 1px solid #27272a; display: flex; align-items: center; gap: 8px; }
            h1 { font-size: 15px; font-weight: 600; margin: 0; flex: 1; }
            .new-btn { background: #6366f1; color: #fff; border: none; border-radius: 999px; padding: 6px 14px; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; text-decoration: none; line-height: 1; }
            .new-btn:active { background: #4f46e5; }
            .session { position: relative; padding: 8px 10px 8px 36px; margin-bottom: 4px; border: 1px solid #27272a; border-radius: 8px; background: #18181b; }
            .session:active { background: #1f1f23; }
            .session.is-pinned { border-color: #4338ca; background: #1a1827; }
            .pin-btn { position: absolute; top: 50%; left: 6px; transform: translateY(-50%); width: 24px; height: 24px; padding: 0; background: none; border: 0; cursor: pointer; opacity: 0.35; font-size: 13px; line-height: 1; color: inherit; filter: grayscale(1); }
            .pin-btn.pinned { opacity: 1; filter: none; }
            .pin-btn:active { transform: translateY(-50%) scale(0.92); }
            .session-link { display: flex; align-items: baseline; gap: 8px; color: inherit; text-decoration: none; padding-right: 76px; min-width: 0; }
            .session-link strong { flex: 1; font-size: 13.5px; font-weight: 500; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; color: #f4f4f5; }
            .session-link small { flex-shrink: 0; font-size: 11px; color: #71717a; font-weight: normal; }
            .compact-btn { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); font-size: 11px; font-weight: 500; padding: 4px 10px; border-radius: 999px; background: #312e81; color: #c7d2fe; border: 1px solid #4338ca; text-decoration: none; line-height: 1; }
            .compact-btn:active { background: #4338ca; color: #fff; }
            .empty { padding: 24px 12px; color: #71717a; font-size: 13px; text-align: center; }
          </style>
        </head>
        <body>
          <header>
            <h1>工作階段</h1>
            <form method="post" action="/c/new-session" style="margin:0;">
              <button class="new-btn" type="submit">+ 新</button>
            </form>
          </header>
          ${items || "<div class='empty'>目前沒有工作階段</div>"}
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

  if (req.method === "GET" && req.url === "/remote-sessions") {
    void handleRemoteSessions(res);
    return;
  }

  if (req.method === "GET" && req.url === "/c-mockup") {
    sendCompactMockup(res);
    return;
  }

  if (req.method === "GET") {
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

function resolveOpenCodeCommand(): string {
  if (process.env.OPENCODE_CLI_PATH) {
    return process.env.OPENCODE_CLI_PATH;
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const localCli = join(localAppData, "opencode", "opencode-cli.exe");
      if (existsSync(localCli)) {
        return localCli;
      }
    }
  }

  return "opencode";
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
  console.log(`[opencode-remote] spawning opencode serve in ${config.opencodeDirectory}`);
  const opencodeCmd = resolveOpenCodeCommand();
  const oc = spawn(
    opencodeCmd,
    ["serve", "--hostname", "127.0.0.1", "--port", String(config.opencodePort)],
    {
      cwd: config.opencodeDirectory,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: "" },
    },
  );
  oc.on("exit", async (code) => {
    console.error(`[opencode-remote] opencode exited with code ${code}`);
    // If another OpenCode is already healthy on this port, don't crash
    try {
      const r = await fetch(`${config.opencodeUrl}/global/health`);
      const j = (await r.json()) as { healthy?: boolean };
      if (j.healthy) {
        console.log("[opencode-remote] existing OpenCode instance is healthy; continuing");
        return;
      }
    } catch { /* fall through */ }
    process.exit(1);
  });

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

  // 7. Start HTTP proxy server
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`[opencode-remote] proxy listening on http://0.0.0.0:${config.port}`);
    console.log("[opencode-remote] → redirecting / to /remote-sessions");
    console.log(`[opencode-remote] → redirecting /latest to ${activeSessionPath}`);
  });
}

main().catch((err) => {
  console.error("[opencode-remote] fatal:", err);
  process.exit(1);
});
