# opencode-remote

Mobile PWA remote-control interface for [OpenCode](https://opencode.ai) — lets you dispatch prompts, monitor job progress, and handle permission requests from an iPhone while the agent runs on a desktop host in the background.

## Architecture

Three packages in a single npm workspace:

```
packages/web     — React + Vite PWA (iPhone shell, SSE consumer, push subscriber)
packages/server  — Fastify + SQLite API server (state authority, SSE hub, job queue)
packages/runner  — Long-running Node process on the dispatch host (polls jobs, drives opencode serve)
```

```
iPhone PWA
  → HTTPS REST / SSE / Web Push
packages/server  (port 9527 / internal 9223)
  → internal control-plane REST (x-runner-token)
packages/runner
  → local OpenCode HTTP API  http://127.0.0.1:4096
opencode serve
```

## Key Concepts

- **Thread** — persistent conversation context; maps 1:1 to an OpenCode session
- **Job** — a single dispatched prompt; queued → running → completed/failed
- **Thread events** — append-only timeline replayed on SSE reconnect
- **Lease/heartbeat** — runner must renew within `RUNNER_LEASE_MS` or the job is reclaimable by another runner instance
- **Session unhealthy** — when a real job fails, `opencode_session_id` is cleared and thread status becomes `attention`; next dispatch creates a fresh session (no silent remap)

## Database

SQLite at `DATABASE_PATH` (default `/data/opencode-remote.db`). Schema managed via versioned migrations in `packages/server/src/db/index.ts → runMigrations()`.

Migrations table: `_migrations` — each row is a named, idempotent migration applied at startup.

Current migrations:
- `001_initial_schema` — all core tables + indexes
- `002_permission_response_column` — adds `response` column to `permission_requests`

## API Surface

### Public (web client)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Healthcheck |
| GET | `/api/projects` | List projects |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id/threads` | List threads |
| POST | `/api/projects/:id/threads` | Create thread |
| GET | `/api/threads/:id` | Thread detail (jobs, events, permissions) |
| GET | `/api/threads/:id/stream` | SSE event stream (supports `?after=<eventId>`) |
| POST | `/api/threads/:id/dispatch` | Queue a prompt |
| POST | `/api/jobs/:id/abort` | Request job abort |
| POST | `/api/threads/:id/permissions/:requestId` | Answer permission request |
| POST | `/api/push/subscriptions` | Register push subscription |

### Internal (runner only, requires `x-runner-token`)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/jobs/claim` | Claim next queued job |
| POST | `/internal/jobs/:id/heartbeat` | Renew lease, get abort/permission signals |
| POST | `/internal/jobs/:id/events` | Post timeline events |
| POST | `/internal/jobs/:id/status` | Mark completed/failed |
| POST | `/internal/jobs/:id/permissions` | Upsert permission request |
| POST | `/internal/jobs/:id/permissions/:reqId/replied` | Mark permission replied |
| POST | `/internal/threads/:id/session` | Set OpenCode session mapping |
| POST | `/internal/threads/:id/session/unhealthy` | Clear session mapping, set attention status |

## Environment Variables

See `.env.example`. Key vars:

| Variable | Default | Where |
|----------|---------|-------|
| `PORT` | `9223` | server |
| `DATABASE_PATH` | `./data/opencode-remote.db` | server |
| `RUNNER_SHARED_TOKEN` | `change-this-runner-token` | server + runner |
| `DISPATCH_SERVER_URL` | `http://localhost:9223` | runner |
| `RUNNER_EXECUTION_MODE` | `stub` | runner (`stub` / `real`) |
| `OPENCODE_SERVER_URL` | `http://127.0.0.1:4096` | runner |
| `OPENCODE_DIRECTORY` | _(empty)_ | runner |

## Deployment (AMD 3700X dispatch host)

Port **9527** is exposed externally. Caddy proxies `opencode.sisihome.org → localhost:9527`.

### Quick start

```bash
# 1. Start OpenCode on the host (runner connects to this)
opencode serve

# 2. Copy and fill in env
cp .env.example .env
# Edit RUNNER_SHARED_TOKEN (any random string)

# 3. Build and start
docker compose up -d --build
```

### docker-compose services

- **server** — serves the PWA and REST/SSE API; exposes `9527:9223`; data volume at `/data`
- **runner** — polls server, drives OpenCode; connects to server via `http://server:9223`; reaches host OpenCode via `host.docker.internal:4096`

> On Linux, `extra_hosts: host.docker.internal:host-gateway` maps the runner container to the host's network so it can reach `opencode serve`.

### Caddy config snippet

```caddyfile
opencode.sisihome.org {
    reverse_proxy localhost:9527
}
```

### PWA install (iPhone)

1. Open `https://opencode.sisihome.org` in Safari
2. Share → Add to Home Screen
3. Grant notification permission when prompted (required for Web Push)

## Development

```bash
npm install

# Run all three packages concurrently
npm run dev

# Or individually
npm run dev:web     # Vite dev server
npm run dev:server  # tsx watch (Fastify)
npm run dev:runner  # tsx watch (runner, defaults to stub mode)
```

For real runner mode during dev:
```bash
RUNNER_EXECUTION_MODE=real npm run dev:runner
```

## Version

Current: **v0.2.0**

## OpenSpec

Design decisions, specs, and task tracking live in `openspec/`:

- [`openspec/changes/init-opencode-remote/design.md`](openspec/changes/init-opencode-remote/design.md) — architecture decisions (server-authoritative, session mapping, SSE vs push, etc.)
- [`openspec/changes/init-opencode-remote/proposal.md`](openspec/changes/init-opencode-remote/proposal.md) — original project proposal
- [`openspec/changes/init-opencode-remote/tasks.md`](openspec/changes/init-opencode-remote/tasks.md) — implementation task checklist
- [`openspec/changes/init-opencode-remote/specs/dispatch-threads/spec.md`](openspec/changes/init-opencode-remote/specs/dispatch-threads/spec.md) — thread/job dispatch spec
- [`openspec/changes/init-opencode-remote/specs/pwa-shell/spec.md`](openspec/changes/init-opencode-remote/specs/pwa-shell/spec.md) — PWA shell spec
- [`openspec/changes/init-opencode-remote/specs/push-notifications/spec.md`](openspec/changes/init-opencode-remote/specs/push-notifications/spec.md) — Web Push spec
- [`openspec/changes/remote-client/proposal.md`](openspec/changes/remote-client/proposal.md) — v0.2 remaining work + mobile UX goals
