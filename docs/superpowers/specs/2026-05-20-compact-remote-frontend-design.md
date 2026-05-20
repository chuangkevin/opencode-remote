# Compact Remote Frontend Design

> Status: approved design draft from superpowers:brainstorming
> Date: 2026-05-20
> Scope: Custom compact frontend for opencode-remote, optimized for small
> landscape touch devices (Anbernic RG DS 640×480 dual screen via GammaOS
> Next DualStack → effectively a 640×960 vertical canvas in one browser
> window). Replaces the native OpenCode SPA for mobile/handheld use only;
> the existing transparent proxy and Desktop SPA path remain unchanged.

## Goal

A self-built compact web UI that bypasses the native OpenCode SPA for
small-screen handhelds, so the user can fire-and-forget tasks to opencode
from a portable device: type a prompt (optionally with images), send, close
the page, and let opencode keep running on `kevinhome`. The user can return
later — from the same device or a different one — refresh, and pick up the
streaming/final result.

The compact UI must also let the user pick model and thinking complexity
per session, with the same persistence semantics as the existing native
OpenCode remote (the choice is stored on the OpenCode session record and
restored when the session is reopened).

## Non-Goals

- Do not rewrite the existing proxy or change Desktop SPA redirect behavior.
- Do not introduce a build step (no Vite, no bundler, no transpilation).
- Do not introduce a new package or framework dependency (no Preact, React,
  Vue, Svelte). Server-rendered HTML + vanilla ES modules only.
- Do not render rich tool-call inspection (parameter trees, diffs, todos,
  subagent transcripts). Tool calls collapse to a single summary line.
- Do not implement client-side history retention or offline storage. The
  authoritative history is the OpenCode session record; the compact UI
  always re-fetches from the server.
- Do not implement code syntax highlighting. Code blocks render as `<pre>`
  with monospace font and a flat background.
- Do not implement a "pending tool approvals" queue UI. Fire-and-forget
  relies on trust mode rather than queued approvals.
- Do not implement RG-DS-specific input bindings (physical buttons, custom
  hardware keys). The UI is just a touchscreen web page.
- Do not implement an in-app keyboard. The OS soft keyboard handles typing.

## Decisions

### 1. Architecture: server-rendered HTML + vanilla ES modules

Compact lives inside `packages/server`. The Node HTTP server gains three
new route handlers and serves vanilla JS/CSS as static files. There is no
build step — editing the source files and restarting the server is the
entire dev loop, matching how `/remote-sessions` works today.

Justification:
- The MVP is small (one chat view, a model picker overlay, three buttons).
  A component framework would cost more than it saves.
- The existing `/remote-sessions` handler in `packages/server/src/index.ts`
  already demonstrates the server-rendered HTML + dark-themed mobile CSS
  pattern. Compact follows the same style for consistency.
- No build step means no changes to `start.ps1`, `Dockerfile`, Caddy, or
  CI. Deployment surface is unchanged.

### 2. URL routing

| Route | Method | Behavior |
|---|---|---|
| `/remote-sessions` | GET | Existing handler. **Modified**: card links point to `/c/session/<id>` instead of `/<base64url(dir)>/session/<id>`. |
| `/c/session/:id` | GET | New. Renders the compact session HTML shell. The `:id` is the OpenCode session id (`ses_xxx`). |
| `/c/static/compact.js` | GET | New. Serves the static JS module. |
| `/c/static/compact.css` | GET | New. Serves the static CSS. |
| `/c/static/marked.min.js` | GET | New. Serves the bundled `marked` library (vendored — not loaded from CDN). |
| `/c/new-session` | POST | New. Creates a session in `OPENCODE_DIRECTORY` (`POST /session`), then 303-redirects to `/c/session/<new id>`. |

All other paths continue to pass through the existing transparent proxy
unchanged. Native SPA paths (`/<base64url(dir)>/session/<id>`) keep working
on Desktop. Switching between compact and native is a manual URL change;
there is no UA-based redirection.

### 3. Session list reuse

The compact UI does not ship its own session list. The user lands on
`/remote-sessions` (already mobile-friendly), taps a card → enters
`/c/session/<id>`. A `+ 新 session` button on `/remote-sessions` calls
`POST /c/new-session`.

The `/remote-sessions` handler is modified in exactly one place: the `href`
that each card emits. Everything else (layout, sort order, filtering via
`isUserSession`) stays the same.

### 4. Fire-and-forget mechanism

The session viewer never depends on the browser tab staying open after the
user hits Send. The flow:

1. User types prompt (and optionally attaches images via `<input type=file>`,
   which the JS converts to `data:` URLs using `FileReader.readAsDataURL`).
2. User hits Send.
3. Compact JS calls `POST /session/:id/message` with body:
   ```json
   {
     "model": { "providerID": "openai", "modelID": "gpt-5.5" },
     "variant": "medium",
     "parts": [
       { "type": "text", "text": "<the prompt>" },
       { "type": "file", "mime": "image/jpeg", "url": "data:image/jpeg;base64,..." }
     ]
   }
   ```
4. As soon as the POST returns 200 (typically <100ms once OpenCode has
   queued the work), the UI is free. The user can close the tab, lock the
   screen, walk away. Opencode keeps processing.
5. When the user comes back (same or different device), they navigate to
   `/c/session/:id`, the JS does `GET /session/:id/message?limit=30`,
   renders the latest state, and subscribes to `GET /event` SSE for live
   updates.

The proxy already maintains a background SSE keep-alive to prevent opencode
from idling out. No change there.

Note on the message endpoint: at design time it is not 100% verified
whether `POST /session/:id/message` returns immediately after queueing
the work or blocks until the assistant finishes. The implementer must
probe this at implementation time by sending a long-running prompt and
measuring response latency. If it blocks, the implementer switches to
`POST /session/:id/prompt_async` (and/or sets `noReply: true` on the
message payload — both options are visible in the OpenAPI doc). The UI
behavior is identical either way; only the call shape changes. The
choice is recorded as part of the implementation plan, not re-litigated
in this spec.

### 5. Trust mode mechanism

Fire-and-forget cannot work if the AI blocks on permission requests while
the browser is gone. Compact sessions therefore run under a relaxed
permission ruleset: every `ask` rule in `opencode.json` is rewritten to
`allow`; every `deny` is preserved as-is.

Implementation: the user (or a one-time setup pass) toggles trust mode at
the **OpenCode session record** level via `PATCH /session/:id` with a
`permission` ruleset payload. The compact UI exposes a single toggle in
the model picker overlay (intentionally co-located for UI compactness on a
640×480 screen — semantically distinct from model selection, but lives in
the same overlay to avoid a second always-visible affordance): `🔓 Trust
mode`. When ON, the UI patches the session with the all-allow ruleset
(keeping the existing `deny` patterns from `opencode.json` verbatim). When
OFF, the UI patches the session back to whatever was originally there.

The trust mode flag lives on the session record itself, so it persists
across refreshes and devices. New sessions created via `/c/new-session`
default to trust mode ON.

If `PATCH /session/:id` does not actually accept the per-session permission
override (the OpenAPI suggests it does, but this is unverified runtime
behavior), fallback option: have the proxy intercept `POST /c/new-session`
and `POST /session/:id/message` originating from `/c/*` and inject a
relaxed `permission` override into the payload. This fallback is recorded
here so the implementation plan can pick whichever path actually works
without re-litigating the design.

### 6. Model + variant picker

The compact header shows the current model and variant as a single tap
target (`gpt-5.5 · medium`). Tapping opens a full-screen overlay listing
every enabled model from `GET /provider`, grouped by provider name. Each
model that declares `variants` (e.g., `low` / `medium` / `high`) renders
as a row with three pill buttons; models without variants render as a
single button. Tapping a (model, variant) closes the overlay.

The current selection comes from `GET /session/:id`:
- `session.model.providerID` → `model.providerID` on the POST
- `session.model.id` → `model.modelID` on the POST
- `session.model.variant` → `variant` on the POST

When the user changes the picker, the change is **not** persisted as a
separate API call. Instead the next `POST /session/:id/message` carries
the new selection. OpenCode updates `session.model` server-side on receipt.
Reopening the session later reads the same `session.model` back, so the
choice survives across refreshes and devices.

Edge case: brand-new session with no `session.model` yet. The picker
defaults to the workspace default (`opencode.json`'s `model` field — read
once via `GET /config`).

### 7. Image upload

The attach button (`📎`) opens a native `<input type="file" accept="image/*" multiple>`.
On selection, each file is read with `FileReader.readAsDataURL` and held in
an in-memory `pendingAttachments[]` list with thumbnail previews shown
above the input field. On Send, the attachments become `FilePartInput`
entries in the `parts` array (one `text` part + N `file` parts).

Max size is enforced client-side at 5 MB per image, total request body
≤ 20 MB. Larger files are rejected with a toast. No separate upload
endpoint is involved — OpenCode accepts the data URL directly.

### 8. Markdown rendering

`marked` (vendored to `/c/static/marked.min.js`, ~30 KB) renders every
assistant message body and every user message body. Code fences render as
`<pre><code>` with `font-family: ui-monospace, Menlo, Consolas, monospace`
and `background: #1f1f23`. No syntax highlighting.

Streaming markdown: as new chunks arrive via SSE, the entire current
message's text is re-parsed and the DOM node is replaced. This is wasteful
in theory but trivially fast for messages under a few hundred KB. Partial
markdown states (unclosed code fence etc.) render imperfectly mid-stream;
this is acceptable.

Safety: assistant output is not user-generated; risk surface is low.
Compact UI calls `marked` with `gfm: true`, `breaks: true`, and no HTML
extensions. The default `marked` behavior strips raw HTML to text.

### 9. History rendering

`GET /session/:id/message?limit=30` on session open returns the most
recent 30 messages. They render in chronological order (oldest at top,
newest at bottom, view auto-scrolls to bottom on initial load).

Sticky-scroll for live updates: while a new SSE part arrives, if the user
is currently within 50px of the bottom the view follows the new content;
if the user has scrolled up to read older context, the view stays put and
a small `↓ <N> 則新訊息` chip appears at the bottom right (tapping it
scrolls down).

There is no "Load older" control in MVP; the user can return to the
native SPA on Desktop for full history if needed.

The proxy does not cache history client-side or server-side. Every page
load re-fetches from OpenCode.

### 10. Tool call rendering

Each tool invocation renders as one row inside the assistant's message
bubble: `🔧 <tool_name> · <one-line summary>` (e.g.,
`🔧 edit · packages/server/src/index.ts (+12 -3)`). No expansion, no
parameter tree, no diff view. The summary is derived per tool type:
- `edit` / `write` → filename + line delta if available
- `bash` → first 60 chars of command
- `read` → filename
- everything else → tool name only

## File Layout

```
packages/server/
  src/
    index.ts                  (extended: 3 new routes + modified remote-sessions handler)
    compact/
      handlers.ts             (new: route handlers for /c/* paths)
      shell.ts                (new: HTML template for /c/session/:id)
  static/
    compact.css               (new)
    compact.js                (new)
    marked.min.js             (new: vendored from marked package)
docs/superpowers/specs/
  2026-05-20-compact-remote-frontend-design.md  (this file)
openspec/changes/
  compact-frontend/           (created in plan phase, not now)
```

`compact.js` is a single module (~600–800 lines target):
- Connect SSE
- Render message list (`marked` + DOM)
- Pick model overlay (open / select / close)
- Send handler (text + attachments → POST)
- Abort handler (POST `/session/:id/abort`)
- Attachment intake (`FileReader`)
- Refresh-on-focus (re-fetch latest messages when tab visibility returns)

## Data flow: open compact session

```
User -> /c/session/:id (GET)
  -> server returns HTML shell with embedded sessionID, dirSlug
  -> browser fetches /c/static/{compact.js, compact.css, marked.min.js}
compact.js startup:
  1. GET /session/:id              -> session record (model, title, etc.)
  2. GET /session/:id/message?limit=30  -> recent messages
  3. GET /provider                 -> available models (cached in memory)
  4. EventSource('/event')         -> live updates
  Render: header (model picker), message list, input area, send/stop buttons
```

## Data flow: send message (fire-and-forget)

```
User taps Send:
  compact.js -> POST /session/:id/message {
    model: { providerID, modelID }, variant,
    parts: [text, ...files as data URLs]
  }
  Server (OpenCode) -> 200 within ~100ms, agent loop runs in background
  compact.js updates local UI optimistically (echoes user message),
    clears input + attachments
User closes tab (no harm — work continues server-side)
User returns later -> compact session re-fetches state from /session/:id/message
SSE delivers new assistant message parts as they stream
```

## Data flow: abort

```
User taps Stop (only visible while assistant is streaming):
  compact.js -> POST /session/:id/abort
  Server stops the agent loop, emits a final SSE event
  compact.js receives final event, hides Stop button
```

## Error handling

- **Network failure during Send**: show a toast (`送出失敗：<reason>`),
  keep the input + attachments populated so the user can retry. Do not
  auto-retry — the user might want to edit.
- **SSE disconnection**: EventSource auto-reconnects. If reconnect fails
  for >10s, show a "重新連線中..." banner and force a one-shot fetch of
  `/session/:id/message?limit=30` on each reconnect attempt to catch up.
- **Image too large**: client-side guard, toast, no request sent.
- **Session not found** (404 on GET /session/:id): redirect to
  `/remote-sessions` with a flash message.
- **OpenCode down** (proxy returns 502 for the embedded API calls): show
  a "OpenCode 啟動中或無法連線" banner; keep retrying every 5s.

## Verification

After implementation, the following must hold:

1. From a desktop browser, navigate to `/c/session/<id>` of an existing
   session. The recent message history renders correctly; markdown
   formatting in assistant messages displays as expected (headings, lists,
   code blocks, links).
2. Send a text prompt. The user message appears immediately. The assistant
   reply streams in. Close the tab mid-stream. Re-open the same URL. The
   assistant message is now complete and visible.
3. Attach a JPEG and send a prompt. The image arrives in the assistant's
   view of the conversation (verify by checking the message via the native
   SPA on Desktop afterward).
4. Open the model picker. Select a different model + variant. Send a
   message. Verify `GET /session/:id` shows the new model. Refresh the
   page. The picker preselects the new model.
5. Trust mode ON: send a prompt that requires an edit. The assistant
   completes without prompting for approval and without stalling.
6. From the Anbernic RG DS running GammaOS Next, navigate to
   `https://opencode.sisihome.org/c/session/<id>`. The full 640×960
   DualStack canvas is used; chat history scrolls in the top half; the OS
   soft keyboard fills the bottom half when typing; nothing is clipped
   or pushed off-screen.
7. `npm run typecheck` and `npm run build` pass.

## Out of scope (potential Phase 2)

- "Load older messages" pagination.
- Code syntax highlighting.
- Rich tool-call expansion (diff view, parameter tree, subagent transcripts).
- Pending permission approvals queue UI.
- Per-session sharing links.
- Voice input.
- Push notifications when a long-running task finishes.

## Notes for the implementer

- The OpenAPI doc at `GET /doc` is the authoritative source for request
  and response shapes. Probe it again at implementation time — endpoints
  have been moving as OpenCode upgrades.
- Vendoring `marked.min.js` (not loading from CDN) is intentional: the RG
  DS may sometimes operate on networks where CDN reachability is
  inconsistent, and the proxy is the single trusted origin.
- `packages/server/src/index.ts` is already 1040 lines; new handlers
  should go into a new sibling file (`compact/handlers.ts`) rather than
  growing `index.ts` further.
- The existing `/remote-sessions` handler's only change is the `href`
  generated for each card. Keep the diff minimal.
- Commit attribution rule for opencode-authored commits:
  `Co-Authored-By: Kevin-AI <kevin950805@gmail.com>`.
