# Compact Remote Frontend — Handoff

> **Date:** 2026-05-20
> **Status:** Phase 1 implementation 13 / 17 tasks done (+ 1 user-requested addition).
> **Branch:** `main` (all commits pushed to `origin/main`).
> **Spec:** [`docs/superpowers/specs/2026-05-20-compact-remote-frontend-design.md`](../specs/2026-05-20-compact-remote-frontend-design.md)
> **Plan:** [`docs/superpowers/plans/2026-05-20-compact-remote-frontend.md`](../plans/2026-05-20-compact-remote-frontend.md)
> **Mockup:** [`mockups/compact-mockup.html`](../../../mockups/compact-mockup.html) (served at `/c-mockup` for review; **removed by T17**)

## Why this exists

OpenCode's native SPA does not work usably on small landscape devices
(verified failure on iPhone 15 Pro landscape; primary target is Anbernic
RG DS dual-screen via GammaOS DualStack — effectively a 640×960 vertical
canvas). The native SPA also breaks the fire-and-forget workflow: closing
the browser tab during a stream stops the agent.

The compact frontend bypasses the native SPA for handheld use while
keeping the Desktop SPA path unchanged. It is server-rendered HTML + a
single vanilla ES module — **no build step beyond the existing `tsc`**,
no framework dependency.

## What works right now

Open `https://opencode.sisihome.org/remote-sessions` (or
`http://localhost:9223/remote-sessions`). Each session card has a small
purple **Compact** pill at the top-right. Tap the card body → native
SPA. Tap **Compact** pill → `/c/session/<id>` — the new compact view.

Inside the compact view:

- **Markdown-rendered chat history** (last 30 messages, via vendored
  `marked@12.0.2`). Tool calls render as one-line `🔧 <name> · <summary>`
  rows.
- **Live streaming via SSE.** EventSource auto-reconnects; on reconnect
  we re-fetch history to catch any missed events. Stickly-scroll chip
  appears bottom-right with `↓ N 則新訊息` if the user scrolls away while
  streaming.
- **Send (fire-and-forget).** Hits `POST /session/:id/prompt_async`,
  returns 204 in ~300 ms. The user can close the tab immediately; the
  agent keeps running. Verified end-to-end: opened tab, closed
  mid-stream, reopened 30 s later — completed reply was rendered.
- **Image attachments.** `📎` opens a file picker. `FileReader.readAsDataURL`
  → `data:` URL → `FilePartInput` entry in the POST body. 5 MB per-file
  cap, 20 MB total. Thumbnails render above the input bar with `×`
  remove.
- **Abort.** Action button flips to red `■` while streaming. Click sends
  `POST /session/:id/abort` and immediately flips state back.
- **Auto-grow textarea + Enter submits + Shift+Enter newline.**
- **Model + variant picker.** Tap the header chip (currently shows
  `gpt-5.5 · …` or the workspace default) → full-screen overlay listing
  authed providers' active models with their actual variant arrays.
  See "Known limitations" below for the persistence caveat.
- **Trust mode toggle** in the picker overlay. PATCHes
  `session.permission` to an array that flips opencode.json's "ask"
  rules to "allow" while preserving the "deny" patterns. See
  "Known limitations" for the OpenCode v1.14.30 quirk.
- **Session title in the header.** Tap to inline-edit; Enter saves via
  `PATCH /session/:id { title }`; Escape cancels; blur saves.
- **Fullscreen toggle** (`⛶` button) — `requestFullscreen()` on the
  page root.
- **Refresh on visibility return:** the visibilitychange handler is NOT
  yet wired (T13 pending). Currently a manual page reload pulls latest.

## Architecture in one minute

```
Browser
   │
   ▼
Caddy on RPi  (opencode.sisihome.org)  ──► transparent reverse proxy
   │
   ▼
proxy on kevinhome :9223        (packages/server/src/index.ts)
   │
   ├── transparent pipe for native SPA paths and all OpenCode API
   ├── /remote-sessions          (HTML session picker with Compact pill)
   ├── /c-mockup                 (preview file; removed by T17)
   ├── /c/session/:id            (compact HTML shell)
   ├── /c/static/<filename>      (compact.css / compact.js / marked.min.js)
   └── /remote-* (existing)      (health, debug, reset, etc.)
   │
   ▼
opencode-cli serve :4096        (localhost-only)
```

The compact UI runs purely client-side. The proxy only renders the
shell HTML and serves three static files. The client (`compact.js`)
does its own `fetch` and `EventSource` calls directly against the
proxy, which transparently forwards them to OpenCode.

## File map

| File | Purpose | Lines |
|---|---|---|
| `packages/server/src/compact/handlers.ts` | Route handlers: `/c/static/<file>`, `/c/session/:id`, regex matcher | ~60 |
| `packages/server/src/compact/shell.ts` | HTML template for `/c/session/:id` (header, input bar, picker placeholder) | ~56 |
| `packages/server/src/index.ts` | Modified: registers compact routes; modified `/remote-sessions` to add Compact pill | small diff |
| `packages/server/static/marked.min.js` | Vendored `marked@12.0.2` (MD5-verified against unpkg) | 1 (minified) |
| `packages/server/static/compact.css` | Ported from `mockups/compact-mockup.html` minus device-frame chrome | ~527 |
| `packages/server/static/compact.js` | Single vanilla ES module: state, history, SSE, send, attach, abort, picker, trust, title, fullscreen | ~900 |
| `mockups/compact-mockup.html` | Standalone preview file — to be removed by T17 | ~830 |

## Key API discoveries (OpenCode v1.14.30)

These differ from what the spec and OpenAPI doc imply. Implementers
of remaining tasks should treat the OpenAPI doc at `GET /doc` as a
trimmed subset and probe at runtime when shapes matter.

1. **Message shape:** `GET /session/:id/message` returns
   `[{ info: { id, role, time, sessionID }, parts: [...] }]`. The id,
   role, time, etc. live under `info`, not at the root.

2. **Tool part args** live at `part.state.input`, not `part.input` or
   `part.args`.

3. **Message part types observed:**
   - `text` — assistant or user prose
   - `tool` — tool invocation; rendered as one-line summary
   - `file` — attachment; if image, rendered as `<img>` with `data:` URL
   - `reasoning` — internal chain-of-thought; **skipped, not shown to user**
   - `step-start` / `step-finish` — pure metadata boundaries; skipped

4. **SSE events** all come through as anonymous `data:` lines (no
   `event:` header). The JSON has shape `{ type, properties }`. Observed
   types:
   - `message.updated` — new message metadata
   - `message.part.updated` — part finalized (use to refresh authoritative content)
   - `message.part.delta` — incremental text delta (optimistic in-memory accumulation)
   - `session.status` (`status.type: "busy" | "idle"`)
   - `session.idle` — definitive streaming-complete signal
   - `session.updated` — session metadata changed (title, etc.)
   - `server.connected` / `server.heartbeat` — protocol-level, ignored

5. **`POST /session/:id/message` blocks for ~2.75 s** waiting for the
   assistant to complete. **Wrong endpoint for fire-and-forget.**
   `noReply: true` skips the AI reply entirely (also wrong).
   **The correct endpoint is `POST /session/:id/prompt_async`** —
   returns 204 No Content in ~300 ms with the agent running in the
   background.

6. **`PATCH /session/:id { permission: ... }` expects an array**, not
   the object-of-objects from `opencode.json`. Each element is
   `{ permission: "<category>", pattern: "<glob>", action: "allow" | "deny" | "ask" }`.
   See "Known limitations" for the append-only behavior.

7. **`/provider` returns 131 providers.** Filter by `/provider/auth`
   (returns only providers with valid auth — currently `openai`,
   `github-copilot`, `gitlab`, `poe`, `cloudflare-workers-ai`,
   `cloudflare-ai-gateway`). Then filter models to `status === "active"`.
   Variants are dynamic per model: `["none", "low", "medium", "high",
   "xhigh"]` is one observed set. "none" is shown as a `—` pill.

## Known limitations

1. **Model synchronization uses shared message history, not `session.model`.**
   OpenCode accepts `model` and `variant` in the prompt payload and records
   the effective values on user-message metadata even when `session.model`
   remains stale. Compact reads the latest valid user message first, then
   uses legacy compact localStorage, `/config`, and the hard fallback only
   when earlier sources are absent. Native and compact therefore converge on
   the same session model during history refresh; picker-filtered models stay
   visible as the current non-selectable model instead of being rewritten.

2. **Trust mode `PATCH /session/:id { permission: [] }` is append-only.**
   Sending an empty array does not reset overrides. The workaround
   committed in `5e1e2e4` is: trust **OFF** appends `[{bash *: ask}, {edit *: ask}]`
   so last-wins evaluation flips effective behavior back; `refreshTrustToggle`
   uses last-wins scan (not `.some()`) to recover state. Works in
   practice, but `session.permission` grows over toggles — not pretty.
   If the server fixes replace semantics, simplify to `[]` reset.

3. **No syntax highlighting in code blocks** (by design — keeps bundle
   small). Mono font + flat gray bg only.

4. **No "Load older" pagination** (by design — `limit=30` and that's it).

5. **Tool call rows show one-line summary only** — no expansion, no
   diff view, no subagent transcripts.

6. **No pending-permission queue UI.** Fire-and-forget relies on trust
   mode to avoid blocking; if trust mode is off and a tool requires
   approval mid-stream, the agent stalls indefinitely (until someone
   approves via the native SPA).

7. **kevinhome auto-start on boot is still pending** (`openspec/changes/deployment-wiring/tasks.md` §2). Has to be started manually after reboot — `.\start-hidden.ps1`.

## Pending tasks (Phase 1)

These are tasks **left from the original 17-task plan**, in execution
order. See [`docs/superpowers/plans/2026-05-20-compact-remote-frontend.md`](../plans/2026-05-20-compact-remote-frontend.md)
for the verbatim task descriptions with code.

- **T13 — Refresh on focus.** `visibilitychange` handler that re-loads
  history and reconnects SSE when the tab becomes visible again. Small
  task (~10 lines appended to `compact.js`).

- **T14 — `/remote-sessions` href update.** *Superseded* by the user's
  request to add a Compact pill button instead of changing the card
  link. Both flows now exist; T14's original objective (let users get
  to compact from /remote-sessions) is met via the pill. **Mark this
  task complete in the plan checklist.**

- **T15 — `POST /c/new-session` route.** Adds a "+ 新 session" button
  to `/remote-sessions` that creates an empty session in
  `OPENCODE_DIRECTORY` and 303-redirects to `/c/session/<new id>`.
  Plan has full code.

- **T16 — End-to-end verification.** Three device smoke tests:
  - Desktop browser at 640×960 viewport
  - iPhone landscape (852×393) on `opencode.sisihome.org`
  - Anbernic RG DS in GammaOS DualStack (640×960 portrait)
  Update the spec's verification section with `[x]` and evidence.
  Also run `npm run typecheck && npm run build`.

- **T17 — Remove `/c-mockup` route + `mockups/` directory.** Cleanup.
  Modify `index.ts` to drop the `/c-mockup` route registration and the
  `sendCompactMockup` function. Delete the mockups directory.

## How to pick up

1. **Read the spec** (`docs/superpowers/specs/2026-05-20-compact-remote-frontend-design.md`).
2. **Read the plan** (`docs/superpowers/plans/2026-05-20-compact-remote-frontend.md`)
   — specifically the section for whichever T13/T15/T16/T17 you're picking up.
3. **Confirm proxy is running** with `curl http://localhost:9223/remote-health`.
   If not, run `.\start-hidden.ps1`.
4. **Read this handoff** for runtime quirks and known limitations.
5. **Implement.** Each remaining task's code is fully written in the
   plan — typically just append-to-file + commit. Run `npm run build`
   and restart the proxy after server-side changes (`.\stop.ps1; .\start-hidden.ps1`).
   Static asset changes don't need a rebuild — the proxy reads them
   at request time.

## Daily operations

- **Start:** `.\start-hidden.ps1` (background, idempotent — handles
  build, setup, and watchdog)
- **Stop:** `.\stop.ps1`
- **Health:** `curl http://localhost:9223/remote-health` → must return JSON with `healthy: true`
- **Logs:** Proxy logs to its stdout. The hidden background mode swallows
  them. To get logs, run `npm run dev` or `npm start` in a foreground
  terminal instead.

## Commit history (since work began)

All commits are on `origin/main`. Range `36b9565..f8e0bdd` is the
implementation work:

```
36b9565 feat(compact): vendor marked@12 for compact UI markdown rendering
441c027 feat(compact): add /c/static/<filename> handler
934ff05 feat(compact): add /c/session/:id shell handler
d5b09f0 feat(compact): add compact.css ported from approved mockup
764de8c feat(compact): add compact.js skeleton with history rendering
1ae41be feat(compact): auto-grow textarea and Enter-to-submit
f652dba feat(compact): subscribe to /event SSE and live-render messages
c0755a1 feat(compact): send text messages via prompt_async (fire-and-forget)
922ed05 feat(compact): session title + inline rename + fullscreen toggle
13999fa feat(compact): image attachments via FileReader data URLs
8ec6292 feat(compact): abort button
6c4db4b feat(compact): model + variant picker overlay
5e1e2e4 feat(compact): trust mode toggle in picker overlay
f8e0bdd feat(compact): add Compact button to each /remote-sessions card
```

Brainstorming/spec commits (before impl began):

```
b044fab docs: add compact remote frontend design
b34c5a2 docs: add compact frontend HTML mockup
0ffe288 docs: lock visual reference + serve compact mockup via proxy
c20749f docs: add compact remote frontend implementation plan
```

---

## Phase 2 additions (2026-05-21)

After Phase 1 landed, the user exercised the UI and we found a series of
gaps. All of the following shipped on `origin/main` between
`bba6f0a` (T13 / iOS Safari fix) and `0f62ecf`:

### 1. AI question UI + always-on permission auto-accept — `cd4a2c6`

**Problem:** The agent could call the `question` tool to ask the user a
multi-choice question, but compact had no handler — the agent stalled
forever. Same for `permission.asked` events when trust mode didn't
cover a pattern.

**Implementation (`packages/server/static/compact.js`):**
- `permission.asked` → auto POST `/permission/:id/reply {reply:"always"}`,
  always-on, no UI. Deduped by ID via `_autoAcceptedPermissions` Set.
- `question.asked` → render an inline card under `els.messages` with
  per sub-question header + markdown body + option buttons. Single-select
  submits on first click; multi-select uses a "送出" / "略過" footer.
  Maps to `POST /question/:id/reply { answers: string[][] }` or
  `POST /question/:id/reject`.
- `question.replied` / `question.rejected` mark the card answered/skipped
  and disable buttons.
- `drainPendingInteractive()` on boot + visibilitychange to handle
  events that fired while the tab was closed.

**Schema reference:** verified against upstream
`sst/opencode src/{permission,question}/index.ts` (commit didn't fork —
the API matches what's documented in those files).

### 2. Optimistic user message + AI thinking indicator — `aac28a4`

**Problem:**
- After hitting send, the user's own message stayed invisible for
  300–800ms until SSE round-tripped. Looked like nothing happened.
- After assistant `message.updated` arrived but before any `part.delta`
  fired (reasoning phase), the AI bubble was empty for several seconds.
  Easy to mistake for a hung agent.

**Implementation:**
- `renderOptimisticUserMessage()` inserts a Kevin bubble tagged
  `data-optimistic="true"` synchronously inside `sendMessage()`. Cleaned
  up when the real user `message.updated` arrives.
- `renderMessage()` tracks `hasContent`; if assistant message has no
  text/tool/file parts and `isStreaming` is true, appends three pulsing
  dots (`.thinking-indicator`). Removed on first `applyDelta()` call.
- Send-failure path also removes the optimistic placeholder.

### 3. Header ⋯ overflow menu — `a2dacf2`

**Problem:** The `⋯` button in the header was a placeholder mockup
artifact with no JS handler — looked clickable, did nothing.

**Implementation:**
- Lazy-built dropdown with 4 items: 📌 Pin / + 新 session / 在 OpenCode 原生介面打開 / 刪除此 session
- "Native SPA" uses `base64url(TextEncoder.encode(directory))` to
  produce the same URL format as `handleRootRedirect`
- "Delete" → `window.confirm` → `DELETE /session/:id` → navigate to `/remote-sessions`
- Outside-click + Escape close the menu, listeners attached/removed
  symmetrically so menu state is the only source of truth
- Pin label refreshes on each open via `GET /c/pins` (label flips
  between "📌 釘選此 session" and "✕ 取消釘選此 session")

### 4. Pin sessions — `93db006`

**Problem:** OpenCode upstream has no per-session pin (its native SPA's
`pin`/`unpin` is an internal directory-cache mechanism). We built our own.

**Server-side (`packages/server/src/compact/pins.ts`):**
- Storage: `<OPENCODE_DIRECTORY>/.opencode-remote/pins.json`,
  shape `{ "pinned": ["ses_xxx", ...] }`
- Atomic write via tmp + rename
- Module-level Set cache, lazy-loaded
- `listPins()` / `isPinned(id)` / `pinSession(id)` / `unpinSession(id)`
- ID validation: `/^ses_[A-Za-z0-9]+$/`

**Routes (`packages/server/src/index.ts`):**
- `GET    /c/pins`            → string[]
- `POST   /c/pins/:sessionID` → 204 (idempotent)
- `DELETE /c/pins/:sessionID` → 204 (idempotent)
- Regex guard on URL prevents path-segment shenanigans

**UI integration:**
- `/remote-sessions`: pinned sessions partitioned to top, `.is-pinned`
  class for visual highlight, inline script POSTs/DELETEs + reloads
- Compact `⋯` menu: pin/unpin toggle (see #3)

**Verified end-to-end before commit:**
- POST twice → idempotent, file has single entry
- DELETE non-pinned → 204, no-op
- `/remote-sessions` shows pinned card on top with `.is-pinned`
- Click pin → POST → reload → reordered
- Proxy stop+start → `pins.json` reloaded, state preserved
- No regression on other endpoints

### 5. Auto-title fix — `4acc2ca`

**Problem:** `handleCompactNewSession` POSTed
`{ title: "compact" }` → OpenCode's auto-titling never ran. Sessions
stayed called "compact" forever.

**Root cause:** OpenCode's `session.ts isDefaultTitle()` only triggers
LLM-generated titles when the current title matches
`"New session - YYYY-MM-DDTHH:MM:SS.sssZ"`. Any custom title is treated
as user intent and left alone.

**Fix:** POST `{}` (empty body) instead. OpenCode applies its own
timestamp default, then upgrades it after the first exchange.

**Verified:** new session via `/c/new-session` returns title=
`"New session - 2026-05-21T05:33:26.207Z"` (default pattern, auto-title eligible).

**Limitation:** old "compact"-titled sessions are not retroactively
auto-titled. User has to rename via ⋯ menu or PATCH the title manually.

### 6. Watchdog + port-killing safety — `6b46836` + `1441227`

**Problem (not strictly compact, but adjacent):** Docker Desktop
crashed every few tens of minutes. Watchdog log timestamps lined up
exactly with `Service unhealthy; restarting` lines.

**Root cause (two layers):**
1. `start.ps1` / `stop.ps1` used `netstat | Select-String ":$Port.*LISTENING"` —
   substring match. `:4096` matched `:40961` / `:14096` / `:49612` etc.
   Docker Desktop's vpnkit picks random high ephemeral ports, ones
   containing "4096" or "9223" as substring got nuked.
2. This repo's own `docker-compose.yml` publishes 4096 — same port as
   the default `opencode-cli`. Even numeric matching would correctly
   identify and kill Docker's vpnkit binding port 4096.

**Fixes:**
- `6b46836`: substring → `Get-NetTCPConnection -LocalPort <int> -State Listen`
- `1441227`: added process-name allowlist (only kill `node` /
  `opencode-cli` / `opencode`); `stop.ps1` now reads `OPENCODE_PORT`
  from `.env` instead of hardcoding 4096
- User set `OPENCODE_PORT=4196` in `.env` to sidestep the port conflict
  entirely

**Verified:** Docker `Up XX minutes` kept rising across multiple
watchdog ticks. `Get-NetTCPConnection LocalPort=4096` returned only
`com.docker.backend` + `wslrelay`; 4196 returned only `opencode-cli`.

### 7. Prompt queue — `0f62ecf`

**Problem:** While AI was responding, the send button doubled as Stop
and there was no way to queue follow-up prompts. User had to wait for
each response to complete.

**Implementation:**
- Action button stays as ▶ "send" regardless of streaming state.
- New ■ Stop button (in shell.ts) shown only while `isStreaming === true`.
- `sendMessage()` splits into thin entry point + `sendNow()`. When
  streaming, prompt is appended to the queue instead of POSTed.
- Storage: `localStorage["compact-queue:<sessionID>"]`,
  shape `[{ id, text, attachments, model, queuedAt }, ...]`
- Queued items render inline as `.msg.queued` with `⏳ 已排入佇列` header
  and × remove button. Muted styling (opacity 0.72 + left border).
- `drainQueueIfIdle()` runs on `session.idle` / `session.status idle`
  SSE events. Pops head, calls `sendNow()`. If POST fails, item is
  put back at head for next retry. `_draining` flag prevents re-entry.
- Boot + visibilitychange: queue items re-rendered from localStorage.
  Boot also schedules a +2s fallback drain attempt to handle the case
  where AI was idle when the tab loaded but no idle event arrives.
- `loadHistory()` clears `queueNodes` alongside other DOM-node caches.

**Verified end-to-end via Playwright on a fresh session:**
1. Send first prompt → AI replies "ack"
2. While streaming, click ▶ twice with different text → both render as
   queued; both persist to localStorage
3. AI completes → drain auto-sends queued ONE → AI replies "ack"
4. Idle again → drain auto-sends queued TWO → AI replies "ack"
5. End state: chat has 3 Kevin/AI pairs, queue empty, ■ Stop hidden

**Known limitations:**
- localStorage isn't synced across browsers → per-device queue
- Two open tabs of same session may both drain head → duplicate sends
- Stop button aborts in-flight response but leaves queue intact (user
  removes items individually with ×)

### File touch summary (Phase 2)

| File | New / Modified |
|---|---|
| `packages/server/src/compact/handlers.ts` | M (auto-title body change) |
| `packages/server/src/compact/pins.ts` | **N** |
| `packages/server/src/compact/shell.ts` | M (added `stopBtn`) |
| `packages/server/src/index.ts` | M (`/c/pins/*` routes + `/remote-sessions` pin partition) |
| `packages/server/static/compact.js` | M (large: question UI, queue, ⋯ menu, optimistic, thinking) |
| `packages/server/static/compact.css` | M (queued styling, question card, thinking dots, dropdown) |
| `start.ps1` / `stop.ps1` | M (numeric port + allowlist) |
| `.env` | M (`OPENCODE_PORT=4196`) — local only, gitignored |

### Phase 2 known gaps (left for later)

- Cross-device queue sync (would need server-side queue endpoint)
- Multi-tab drain coordination (broadcast channel or server-side lock)
- Auto-title retroactive backfill for old "compact" sessions
- Pin order within pinned group (currently `time.updated` desc; could
  honor pin time order from `pins.json` array order)
- Question UI custom answer text input (`custom: true` field) — not
  rendered; only listed options are clickable
