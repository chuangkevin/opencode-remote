# opencode-remote — Project Memory

## Status (v0.2.0 · 2026-04-17)

Core implementation is complete and runnable. Three packages exist with working code.

### Completed (P0)
- [x] Monorepo scaffold (web + server + runner)
- [x] SQLite schema: projects, threads, jobs, thread_events, permission_requests, push_subscriptions
- [x] Versioned migration system (`_migrations` table, `runMigrations()`)
- [x] Full REST API: thread CRUD, dispatch, abort, permission reply, push subscription
- [x] SSE event stream with replay (supports `?after=<eventId>`)
- [x] Runner: poll/claim/heartbeat/lease, OpenCode bridge, stub + real execution modes
- [x] Session mapping: thread → OpenCode session (lazy-create, reuse, unhealthy marking)
- [x] Job abort: `POST /api/jobs/:id/abort` → runner picks up via heartbeat → forwards to OpenCode
- [x] Session unhealthy: runner marks thread on job failure, server endpoint clears session_id
- [x] PWA shell: React + Vite, safe-area, manifest, service worker, Apple meta
- [x] Thread detail UI: timeline, prompt composer, permission buttons, SSE updates
- [x] Dockerfiles: packages/server/Dockerfile (3-stage with native addon support), packages/runner/Dockerfile
- [x] docker-compose.yml: server (port 9527:9223) + runner (host.docker.internal for OpenCode)
- [x] Internal auth: x-runner-token shared secret
- [x] CLAUDE.md created

### Remaining (P1 — mobile UX)
- [ ] SSE reconnect with last-event-id + backoff
- [ ] Offline transcript cache (IndexedDB)
- [ ] Session switching UX
- [ ] Host status panel (connected sessions, CPU/memory)

### Remaining (P2 — push notifications)
- [ ] VAPID key management + push dispatch on job completion/failure/permission
- [ ] iPhone PWA notification grant flow verification

## Deployment Target

- **Host**: AMD Ryzen 3700X + 48GB, Kevin's dispatch machine (always-on)
- **Port**: 9527 (external) → 9223 (internal container)
- **Domain**: opencode.sisihome.org → localhost:9527 via Caddy
- **OpenCode CLI**: runs on the same host, port 4096; runner reaches it via host.docker.internal

## Key Files

- `CLAUDE.md` — full project reference (architecture, API, deployment)
- `docker-compose.yml` — two-service compose (server + runner)
- `packages/server/src/db/index.ts` — AppDatabase class + migrations
- `packages/server/src/index.ts` — Fastify routes
- `packages/runner/src/index.ts` — runner main loop + OpenCode bridge
- `openspec/changes/init-opencode-remote/tasks.md` — task checklist
- `openspec/changes/remote-client/proposal.md` — v0.2 remaining work
