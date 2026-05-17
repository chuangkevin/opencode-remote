import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { encodeDirSlug, isUserSession, listSessions, resolveActiveSessionPath } from "./session.js";

// ─── Proxy ───────────────────────────────────────────────────────────────────

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
  const workspace = next["x-opencode-workspace"];
  const workspaces = Array.isArray(workspace) ? workspace : workspace === undefined ? [] : [String(workspace)];
  if (workspaces.some((value) => value && !isValidWorkspaceID(value))) {
    delete next["x-opencode-workspace"];
  }
  return next;
}

function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const options: http.RequestOptions = {
    hostname: "127.0.0.1",
    port: config.opencodePort,
    path: sanitizeProxyPath(req.url),
    method: req.method,
    headers: {
      ...sanitizeProxyHeaders(req.headers),
      host: `127.0.0.1:${config.opencodePort}`,
    },
  };

  let proxyReq: http.ClientRequest;
  let proxyRes: http.IncomingMessage | undefined;
  let cleanedUp = false;

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    proxyReq.destroy();
    proxyRes?.destroy();
  };

  proxyReq = http.request(options, (upstreamRes) => {
    proxyRes = upstreamRes;
    if (cleanedUp || res.destroyed) {
      upstreamRes.destroy();
      return;
    }

    const isHead = req.method === "HEAD";

    upstreamRes.on("error", () => {
      if (!res.destroyed) res.destroy();
    });

    const headers = { ...upstreamRes.headers, "x-opencode-remote": "true" };
    if (isHead && headers["content-length"] === "0") {
      delete headers["content-length"];
    }
    res.writeHead(upstreamRes.statusCode ?? 200, headers);
    upstreamRes.pipe(res, { end: true });
  });

  proxyReq.on("error", () => {
    if (!res.headersSent && !res.destroyed) {
      res.writeHead(502);
      res.end("Bad Gateway");
    }
  });

  req.on("aborted", cleanup);
  req.on("close", () => {
    if (!req.complete) cleanup();
  });
  res.on("close", () => {
    if (!res.writableEnded) cleanup();
  });

  req.pipe(proxyReq, { end: true });
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
    const sessions = (await listSessions())
      .filter(isUserSession)
      .sort((a, b) => b.time.updated - a.time.updated);
    const items = sessions.map((session) => {
      const path = `/${encodeDirSlug(session.directory)}/session/${session.id}`;
      const title = session.title || session.slug || session.id;
      const directory = session.path ?? session.directory;
      return `<a class="session" href="${path}">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(directory)}</span>
        <small>${escapeHtml(formatTime(session.time.updated))}</small>
      </a>`;
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
            body { margin: 0; background: #111; color: #f4f4f5; padding: max(16px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom)); }
            header { position: sticky; top: 0; z-index: 1; margin: -16px -16px 16px; padding: 18px 16px 12px; background: rgba(17,17,17,.94); backdrop-filter: blur(12px); border-bottom: 1px solid #27272a; }
            h1 { font-size: 20px; margin: 0 0 6px; }
            p { margin: 0; color: #a1a1aa; font-size: 13px; }
            .session { display: grid; gap: 6px; padding: 14px; margin-bottom: 10px; border: 1px solid #2f2f35; border-radius: 14px; background: #18181b; color: inherit; text-decoration: none; }
            .session:active { background: #27272a; }
            strong { font-size: 15px; line-height: 1.35; }
            span, small { color: #a1a1aa; overflow-wrap: anywhere; }
            small { font-size: 12px; }
          </style>
        </head>
        <body>
          <header>
            <h1>工作階段</h1>
            <p>點選後會進入對應 OpenCode session。</p>
          </header>
          ${items || "<p>目前沒有工作階段。</p>"}
        </body>
      </html>`);
  } catch (err) {
    console.error("[opencode-remote] failed to render remote sessions:", err);
    res.writeHead(500, { "Cache-Control": "no-store" });
    res.end("Failed to load sessions");
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

  if (req.method === "GET" && req.url === "/remote-sessions") {
    void handleRemoteSessions(res);
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    handleRootRedirect(res);
    return;
  }

  if (req.method === "GET" && req.url === "/latest") {
    void handleLatestRedirect(res);
    return;
  }
  proxy(req, res);
});

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

  // 6. Start HTTP proxy server
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
