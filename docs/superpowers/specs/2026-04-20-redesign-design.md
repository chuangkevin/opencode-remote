# opencode-remote Redesign

**Date**: 2026-04-20  
**Status**: Approved

## Problem

The original opencode-remote implemented a Job Queue + Runner + Dispatch UI model (like Claude Code Dispatch's prompt-submission model). This is wrong. The user wants to use OpenCode's **native web UI** for conversation — identical to the desktop experience — but accessible from any device (phone, tablet, other PC) with sessions that persist even when the browser closes.

Two root problems with direct OpenCode web access:
1. OpenCode binds to `127.0.0.1` only — other devices can't reach it
2. `GET /` opens the home/new-session screen — no concept of "land on what I was last working on"

## Goal

Any device opens the URL → immediately enters the most recently active session for the configured directory → full native OpenCode web UI (conversation, image upload, session switching via left panel, all features) → work continues on the server even when the browser closes.

## Design

### Architecture

```
Phone / Tablet / PC
       ↓
Caddy (HTTPS, Tailscale) → port 9223
       ↓
opencode-remote proxy (port 9223)
  ├── GET /   → 302 → /<base64url(dir)>/session/<sessionId>
  └── ALL /*  → transparent proxy → OpenCode (127.0.0.1:4096)
                                          ↑
                               child process: opencode serve
```

**URL format discovery (critical):** OpenCode SPA's router pattern is `/:dir/session/:id?` where `:dir` = `base64url(session.directory)` (UTF-8 bytes, no `=` padding). Redirecting to `/<slug>` or `/global/session/<id>` does NOT work — the SPA interprets it differently and may navigate away to a malformed URL, resulting in a blank page.

The proxy is **completely transparent** to OpenCode's web UI. Every feature — conversation, image upload, SSE events, file reading, session switching via the left panel — passes through unmodified.

### Startup Sequence

1. Spawn `opencode serve --hostname 127.0.0.1 --port 4096` as a child process (with `shell: true` on Windows since `opencode` is `opencode.cmd`)
2. If spawn fails due to EADDRINUSE but OpenCode is already healthy on that port, continue using the existing instance
3. Poll `GET /global/health` until `{ healthy: true }`
4. `GET /session` → filter sessions where `directory === OPENCODE_DIRECTORY` → sort by `time.updated` descending → take first. Fallback: globally most recently updated session. Last resort: `POST /session` to create one.
5. Compute `base64url(session.directory)` as the workspace slug and build `/<slug>/session/<session.id>`
6. Store the active session path in memory
7. Start HTTP proxy on `PORT` (default 9223)
8. Open a background SSE client to `GET /event` — keeps OpenCode active even when no browser is connected

### Request Routing

| Request | Behavior |
|---------|----------|
| `GET /` | `302` → `/<base64url(dir)>/session/<sessionId>` |
| Any other path | Transparent proxy to `http://127.0.0.1:4096<path>` |
| SSE (`/event`, `/global/event`) | Proxy with streaming (no buffering) |
| WebSocket (if any) | Proxy as WebSocket |

### Active Session Refresh

The active session path is refreshed every 30 seconds by re-querying `GET /session`, picking the most recently updated session for `OPENCODE_DIRECTORY` and re-computing `/<base64url(dir)>/session/<sessionId>`. This means: if the user switches sessions in the native OpenCode left panel and works there, the next person who opens `/` will land on that session automatically.

### Execution Continuity

OpenCode processes prompts via `prompt_async` — execution is server-side and does not require a connected client. When mobile closes (SSE drops), OpenCode continues running. The background SSE connection from the proxy ensures OpenCode stays active. When the user reopens, the SPA reconnects and streams any pending events from history.

## Code Structure

Keep the `packages/server/` directory but remove the other two packages:

```
packages/
└── server/              # Only remaining package
    └── src/
        ├── index.ts      # node:http server, routing, proxy, startup sequence, keep-alive SSE
        ├── session.ts    # Session resolution + base64url dir encoding
        └── config.ts     # Env config
```

Uses Node.js built-in `node:http` for the proxy (no Fastify runtime dep) — `proxyRes.pipe(res)` handles SSE streaming natively.

Delete `packages/web/` and `packages/runner/` entirely. Simplify root `package.json` to single-workspace or remove workspaces config.

## Configuration

```env
# Required
OPENCODE_DIRECTORY=D:\Projects\_HomeProject

# Optional (with defaults)
PORT=9223
OPENCODE_PORT=4096
SESSION_REFRESH_INTERVAL_MS=30000
```

## Deployment

- **Docker**: Multi-stage build. Stage 1: install OpenCode CLI + build TypeScript. Stage 2: production image with OpenCode CLI binary + compiled JS.
- **Caddy**: Reverse proxy `opencode.sisihome.org` → `localhost:9223`
- **Tailscale**: Access restricted to Tailscale network
- **Data**: No database. Session state is owned by OpenCode (stored in its own data directory, typically `~/.opencode/`). Must be persisted via Docker volume mount: `opencode_data:/root/.opencode`. Proxy holds active slug in memory only — refreshed on each startup and every 30s.

## What Is Removed

| Removed | Reason |
|---------|--------|
| `packages/web/` (custom React UI) | OpenCode native UI replaces it |
| `packages/runner/` (job executor) | OpenCode handles execution natively |
| SQLite database | No state to persist |
| Job Queue (queued/running/failed) | Not the interaction model |
| Permission request handling | OpenCode native UI handles this |
| Dispatch UI | Not needed |
| Manager UI | Not needed |

## Constraints

- OpenCode CLI must be available in the Docker image (installed via npm or binary download)
- Proxy must not buffer SSE streams — pipe directly
- `GET /` redirect must happen before serving the SPA, not inside the SPA
- Background SSE keep-alive must reconnect on disconnect with exponential backoff
- URL must use the exact format `/<base64url(directory)>/session/<sessionId>` — other formats (session slug, `/global/session/<id>`) cause the SPA to navigate away to a malformed URL

## Known Gotchas

- **Windows spawn**: `opencode` is `opencode.cmd` on npm global — requires `shell: process.platform === "win32"`
- **Corrupted session.directory**: Some legacy sessions have non-UTF-8 bytes in their `directory` field (Windows encoding artifact). The URL must encode the session's own `directory` (to match the SPA's internal workspace context), so such sessions produce malformed URLs. Prefer sessions filtered by `directory === OPENCODE_DIRECTORY` so the configured (clean) path is what gets encoded.
- **Port conflict in dev**: If OpenCode is already running on port 4096, the proxy's spawn will fail with EADDRINUSE. The `oc.on("exit")` handler checks if OpenCode is still healthy before crashing the proxy.
