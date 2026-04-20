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
  ├── GET /   → 302 → /<most-recent-session-slug>
  └── ALL /*  → transparent proxy → OpenCode (127.0.0.1:4096)
                                          ↑
                               child process: opencode serve
```

The proxy is **completely transparent** to OpenCode's web UI. Every feature — conversation, image upload, SSE events, file reading, session switching via the left panel — passes through unmodified.

### Startup Sequence

1. Spawn `opencode serve --hostname 127.0.0.1 --port 4096` as a child process
2. Poll `GET /global/health` until `{ healthy: true }`
3. `GET /session` → filter sessions where `directory === OPENCODE_DIRECTORY` → sort by `time.updated` descending → take first
4. If no session exists → `POST /session` to create one for `OPENCODE_DIRECTORY`
5. Store the active slug in memory
6. Start Fastify proxy on `PORT` (default 9223)
7. Open a background SSE client to `GET /event` — keeps OpenCode active even when no browser is connected

### Request Routing

| Request | Behavior |
|---------|----------|
| `GET /` | `302` → `/<active-slug>` |
| Any other path | Transparent proxy to `http://127.0.0.1:4096<path>` |
| SSE (`/event`, `/global/event`) | Proxy with streaming (no buffering) |
| WebSocket (if any) | Proxy as WebSocket |

### Active Session Refresh

The active slug is refreshed every 30 seconds by re-querying `GET /session`, picking the most recently updated session for `OPENCODE_DIRECTORY`. This means: if the user switches sessions in the native OpenCode left panel and works there, the next person who opens `/` will land on that session automatically.

### Execution Continuity

OpenCode processes prompts via `prompt_async` — execution is server-side and does not require a connected client. When mobile closes (SSE drops), OpenCode continues running. The background SSE connection from the proxy ensures OpenCode stays active. When the user reopens, the SPA reconnects and streams any pending events from history.

## Code Structure

Keep the `packages/server/` directory but remove the other two packages:

```
packages/
└── server/              # Only remaining package
    └── src/
        ├── index.ts      # Fastify server, routing, startup sequence
        ├── proxy.ts      # HTTP + SSE transparent proxy
        ├── session.ts    # Find/create active session logic
        └── config.ts     # Env config with validation
```

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
