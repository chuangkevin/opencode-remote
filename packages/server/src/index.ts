import http from "node:http";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { resolveActiveSlug } from "./session.js";

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
    res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
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

let activeSlug = "";

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    if (!activeSlug) {
      res.writeHead(503);
      res.end("Starting up — please wait and refresh");
      return;
    }
    res.writeHead(302, { Location: `/${activeSlug}` });
    res.end();
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

async function refreshSlug(): Promise<void> {
  try {
    activeSlug = await resolveActiveSlug();
    console.log(`[opencode-remote] active session slug: ${activeSlug}`);
  } catch (err) {
    console.error("[opencode-remote] failed to resolve active session:", err);
  }
}

async function main(): Promise<void> {
  // 1. Spawn OpenCode headless server
  console.log(`[opencode-remote] spawning opencode serve in ${config.opencodeDirectory}`);
  const oc = spawn(
    "opencode",
    ["serve", "--hostname", "127.0.0.1", "--port", String(config.opencodePort)],
    { cwd: config.opencodeDirectory, stdio: "inherit", shell: process.platform === "win32" },
  );
  oc.on("exit", (code) => {
    console.error(`[opencode-remote] opencode exited with code ${code}`);
    process.exit(1);
  });

  // 2. Wait for OpenCode to be healthy
  console.log("[opencode-remote] waiting for OpenCode to be ready...");
  await waitForOpenCode();
  console.log("[opencode-remote] OpenCode is ready");

  // 3. Resolve initial active slug
  await refreshSlug();

  // 4. Periodically refresh the active slug
  setInterval(() => { void refreshSlug(); }, config.sessionRefreshIntervalMs);

  // 5. Keep-alive SSE connection to OpenCode
  startKeepAlive();

  // 6. Start HTTP proxy server
  server.listen(config.port, "0.0.0.0", () => {
    console.log(`[opencode-remote] proxy listening on http://0.0.0.0:${config.port}`);
    console.log(`[opencode-remote] → redirecting / to /${activeSlug}`);
  });
}

main().catch((err) => {
  console.error("[opencode-remote] fatal:", err);
  process.exit(1);
});
