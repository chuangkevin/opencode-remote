import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { encodeDirSlug, listSessions, resolveActiveSessionPath } from "./session.js";

// ─── Proxy ───────────────────────────────────────────────────────────────────

function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const options: http.RequestOptions = {
    hostname: "127.0.0.1",
    port: config.opencodePort,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${config.opencodePort}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const isHead = req.method === "HEAD";

    const headers = { ...proxyRes.headers, "x-opencode-remote": "true" };
    if (isHead && headers["content-length"] === "0") {
      delete headers["content-length"];
    }
    res.writeHead(proxyRes.statusCode ?? 200, headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Bad Gateway");
    }
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
    const sessions = (await listSessions()).sort((a, b) => b.time.updated - a.time.updated);
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

async function handleRootRedirect(res: http.ServerResponse): Promise<void> {
  try {
    activeSessionPath = await resolveActiveSessionPath();
    redirectToSession(res, activeSessionPath);
    return;
  } catch (err) {
    console.error("[opencode-remote] failed to resolve active session for /:", err);
  }

  if (!activeSessionPath) {
    res.writeHead(503, { "Cache-Control": "no-store" });
    res.end("Starting up - please wait and refresh");
    return;
  }

  redirectToSession(res, activeSessionPath);
}

function isMobileRequest(req: http.IncomingMessage): boolean {
  const ua = req.headers["user-agent"] ?? "";
  return /Android|iPhone|iPad|iPod|Mobile/i.test(Array.isArray(ua) ? ua.join(" ") : ua);
}

async function handleMobileRootRedirect(res: http.ServerResponse): Promise<void> {
  redirectToSession(res, "/remote-sessions");
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
    if (isMobileRequest(req)) {
      void handleMobileRootRedirect(res);
      return;
    }

    void handleRootRedirect(res);
    return;
  }
  proxy(req, res);
});

// ─── Keep-alive SSE client ───────────────────────────────────────────────────

function startKeepAlive(): void {
  let delay = 1_000;

  const connect = (): void => {
    const req = http.get(
      `${config.opencodeUrl}/event`,
      { headers: { Accept: "text/event-stream" } },
      (res) => {
        delay = 1_000;
        res.on("data", () => { /* consume to keep stream open */ });
        res.on("end", () => setTimeout(connect, delay));
        res.on("error", () => {
          delay = Math.min(delay * 2, 30_000);
          setTimeout(connect, delay);
        });
      },
    );
    req.on("error", () => {
      delay = Math.min(delay * 2, 30_000);
      setTimeout(connect, delay);
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
    console.log(`[opencode-remote] → redirecting / to ${activeSessionPath}`);
  });
}

main().catch((err) => {
  console.error("[opencode-remote] fatal:", err);
  process.exit(1);
});
