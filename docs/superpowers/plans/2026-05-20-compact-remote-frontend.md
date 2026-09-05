# Compact Remote Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a self-built compact web UI at `/c/session/:id` that lets the user fire-and-forget tasks to opencode from small landscape touch devices (Anbernic RG DS, iPhone landscape), bypassing the native OpenCode SPA's mobile shortcomings while keeping the Desktop SPA path unchanged.

**Architecture:** Server-rendered HTML shell + vanilla ES module client. New route handlers live in `packages/server/src/compact/`; static JS / CSS / vendored `marked` live in `packages/server/static/`. No build step beyond the existing `tsc`. The proxy reads static assets from disk at request time, matching the existing `/c-mockup` and `/remote-sessions` patterns.

**Tech Stack:** Node 22, TypeScript (for server route handlers only), vanilla ES modules + Fetch + EventSource (for client), `marked@12` (vendored, no npm dep), CSS custom properties (dark theme).

**Authoritative spec:** `docs/superpowers/specs/2026-05-20-compact-remote-frontend-design.md`. If anything in this plan conflicts with the spec, the spec wins — re-open it and update this plan.

---

## File Structure

**To create:**

- `packages/server/static/marked.min.js` — vendored `marked@12` UMD build (~26 KB).
- `packages/server/static/compact.css` — dark theme styles, ported from `mockups/compact-mockup.html` minus device-frame chrome.
- `packages/server/static/compact.js` — single ES module, ~600–800 lines, runs the whole compact UI (history fetch, SSE subscription, send, attachments, abort, model picker, trust mode, sticky-scroll, refresh-on-focus).
- `packages/server/src/compact/handlers.ts` — route handlers for `/c/session/:id`, `/c/static/<filename>`, `/c/new-session`.
- `packages/server/src/compact/shell.ts` — HTML template literal that produces the compact session shell with `sessionID` baked into a data attribute.

**To modify:**

- `packages/server/src/index.ts` — wire the new routes; modify `handleRemoteSessions` so each card's `href` points to `/c/session/<id>`; remove the temporary `/c-mockup` route + `sendCompactMockup` function once Task 16 verifies the real flow.

**To remove (after Task 16 verification passes):**

- `mockups/compact-mockup.html`
- `/c-mockup` route registration in `packages/server/src/index.ts`
- `sendCompactMockup` function in `packages/server/src/index.ts`
- `readFileSync`, `dirname`, `fileURLToPath` imports if no longer used

**To leave untouched:**

- `packages/server/src/session.ts` — already exports what we need (`isUserSession`, `listSessions`, `encodeDirSlug`); compact doesn't need new helpers here.
- `packages/server/src/config.ts` — unchanged.
- `start.ps1` / `start-hidden.ps1` / `Dockerfile` / Caddyfile — unchanged. No build step added.

---

## Pre-flight: confirm runtime assumptions

Before Task 1, the implementer runs these probes to confirm the spec's runtime assumptions still hold. Each must pass; if any fails, **stop** and flag to the user.

- [ ] **P1: OpenCode is running and reachable.**

  Run: `curl -s http://localhost:4096/global/health`
  Expected: `{"healthy":true,"version":"..."}`. If 000 or 404, run `.\start-hidden.ps1` and re-check.

- [ ] **P2: Proxy is running and serving the mockup at `/c-mockup`.**

  Run: `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9223/c-mockup`
  Expected: `200`.

- [ ] **P3: Session and message endpoints accept the shapes the spec assumes.**

  Run: `curl -s http://localhost:4096/doc | python -c "import sys,json; d=json.load(sys.stdin); print(list(d['paths']['/session/{sessionID}/message']['post']['requestBody']['content']['application/json']['schema']['properties'].keys()))"`
  Expected: includes `parts`, `model`, `variant`, `agent`, `noReply`. If any key is missing, the spec's `POST /message` payload shape needs revision before continuing.

- [ ] **P4: `PATCH /session/:id` accepts `permission` field.**

  Run: `curl -s http://localhost:4096/doc | python -c "import sys,json; d=json.load(sys.stdin); print(list(d['paths']['/session/{sessionID}']['patch']['requestBody']['content']['application/json']['schema']['properties'].keys()))"`
  Expected: includes `permission`. If missing, plan Task 12 must switch to the fallback (proxy-injected permission override on outgoing messages). Record the decision in Task 12's notes.

---

### Task 1: Vendor `marked@12`

**Files:**

- Create: `packages/server/static/marked.min.js`

- [ ] **Step 1: Make the static dir.**

  Run (PowerShell):
  ```powershell
  New-Item -ItemType Directory packages/server/static -Force | Out-Null
  ```
  Expected: no output, directory exists.

- [ ] **Step 2: Download the vendored library.**

  Run (PowerShell):
  ```powershell
  Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/marked@12/marked.min.js" -OutFile "packages/server/static/marked.min.js"
  ```
  Expected: file written, ~26 KB. Verify with `(Get-Item packages/server/static/marked.min.js).Length` — should be 25000–32000.

- [ ] **Step 3: Confirm the file is a valid UMD bundle that exposes `marked`.**

  Run (PowerShell):
  ```powershell
  node -e "globalThis.window = globalThis; require('./packages/server/static/marked.min.js'); console.log(typeof globalThis.marked, typeof globalThis.marked?.parse)"
  ```
  Expected: `object function`. If you see `undefined undefined`, the URL gave you a non-UMD build — try `https://unpkg.com/marked@12/marked.min.js` instead, or pin to `marked@12.0.2` explicitly.

- [ ] **Step 4: Commit.**

  ```bash
  git add packages/server/static/marked.min.js
  git commit -m "$(cat <<'EOF'
  feat(compact): vendor marked@12 for compact UI markdown rendering

  Vendored from jsdelivr so the compact UI does not depend on CDN
  reachability at runtime. Used by /c/session/:id to render assistant
  messages.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 2: Add the `/c/static/<filename>` route

**Files:**

- Create: `packages/server/src/compact/handlers.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Create the handlers module with a static-file handler.**

  Write to `packages/server/src/compact/handlers.ts`:

  ```ts
  import http from "node:http";
  import { existsSync, readFileSync } from "node:fs";
  import { join, dirname, extname } from "node:path";
  import { fileURLToPath } from "node:url";

  const __filename = fileURLToPath(import.meta.url);
  // tsconfig has rootDir=src outDir=dist, so this file ends up at
  //   packages/server/dist/compact/handlers.js
  // packages/server/static is two levels up from that.
  const STATIC_ROOT = join(dirname(__filename), "..", "..", "static");

  // Only serve files we explicitly recognize — prevents path traversal.
  const ALLOWED: Record<string, string> = {
    "compact.js": "application/javascript; charset=utf-8",
    "compact.css": "text/css; charset=utf-8",
    "marked.min.js": "application/javascript; charset=utf-8",
  };

  export function handleCompactStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    // strip leading /c/static/
    const filename = url.pathname.replace(/^\/c\/static\//, "");
    const contentType = ALLOWED[filename];
    if (!contentType) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end("Not found");
      return;
    }
    const path = join(STATIC_ROOT, filename);
    if (!existsSync(path)) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end(`File not found at ${path}`);
      return;
    }
    const body = readFileSync(path);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
    });
    res.end(body);
  }
  ```

  Quick sanity probe after the first build: `node -e "console.log(require('path').resolve('packages/server/dist/compact', '..', '..', 'static'))"` should print the absolute path to `packages/server/static`. If it does not, the project root layout has shifted and the relative path needs adjustment.

- [ ] **Step 2: Wire the route in `index.ts`.**

  In `packages/server/src/index.ts`, add the import near the other imports:

  ```ts
  import { handleCompactStatic } from "./compact/handlers.js";
  ```

  Then in the `http.createServer((req, res) => { ... })` block (around line 858), add before the final `proxy(req, res)` line:

  ```ts
  if (req.method === "GET" && req.url?.startsWith("/c/static/")) {
    handleCompactStatic(req, res);
    return;
  }
  ```

- [ ] **Step 3: Build and verify marked serves.**

  Run:
  ```bash
  npm run build
  ```
  Expected: no errors.

  Run:
  ```bash
  curl -s -o /dev/null -w "%{http_code} %{size_download}\n" http://localhost:9223/c/static/marked.min.js
  ```
  Expected: `200 26000` (or close).

  If the proxy is running with the old code, restart: `.\stop.ps1; .\start-hidden.ps1` (give it 10s, then re-test).

- [ ] **Step 4: Verify path traversal is blocked.**

  Run:
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:9223/c/static/../package.json"
  ```
  Expected: `404` (because `../package.json` is not in `ALLOWED`).

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/server/src/compact/handlers.ts packages/server/src/index.ts
  git commit -m "$(cat <<'EOF'
  feat(compact): add /c/static/<filename> handler

  Whitelist-gated static-file handler for the compact UI's vendored
  marked, compact.js, and compact.css. Path traversal is blocked by
  the allowlist (only filenames in ALLOWED are served).

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 3: Create the compact session HTML shell handler

**Files:**

- Create: `packages/server/src/compact/shell.ts`
- Modify: `packages/server/src/compact/handlers.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Write the HTML shell template.**

  Write to `packages/server/src/compact/shell.ts`:

  ```ts
  function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  export function renderCompactShell(sessionID: string): string {
    const id = escapeAttr(sessionID);
    return `<!doctype html>
  <html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="theme-color" content="#0f0f10" />
    <title>OpenCode</title>
    <link rel="stylesheet" href="/c/static/compact.css" />
    <script src="/c/static/marked.min.js"></script>
  </head>
  <body data-session-id="${id}">
    <div class="app">
      <header class="app-header">
        <a class="header-back" href="/remote-sessions">← Sessions</a>
        <div class="header-spacer"></div>
        <button class="model-chip" id="modelBtn" type="button">
          <span class="dot"></span>
          <span id="modelName">…</span>
          <span class="variant" id="modelVariant"></span>
        </button>
        <button class="header-more" id="moreBtn" type="button" aria-label="more">⋯</button>
      </header>

      <div class="messages" id="messages"></div>

      <div class="scroll-chip" id="scrollChip" hidden>↓ <span id="scrollChipCount">0</span> 則新訊息</div>

      <div class="attach-row" id="attachRow" hidden></div>

      <div class="input-bar">
        <button class="icon-btn" id="attachBtn" type="button" aria-label="附圖">📎</button>
        <input type="file" id="fileInput" accept="image/*" multiple hidden />
        <textarea class="compose" id="compose" placeholder="輸入訊息..." rows="1"></textarea>
        <button class="icon-btn send-btn" id="actionBtn" type="button" aria-label="送出">▶</button>
      </div>

      <div class="picker" id="picker" hidden></div>
      <div class="toast" id="toast" hidden></div>
    </div>
    <script type="module" src="/c/static/compact.js"></script>
  </body>
  </html>`;
  }
  ```

- [ ] **Step 2: Add the route handler in `compact/handlers.ts`.**

  Append to `packages/server/src/compact/handlers.ts`:

  ```ts
  import { renderCompactShell } from "./shell.js";

  const SESSION_PATH_RE = /^\/c\/session\/(ses_[A-Za-z0-9]+)\/?$/;

  export function matchCompactSessionPath(path: string | undefined): string | undefined {
    if (!path) return undefined;
    const m = SESSION_PATH_RE.exec(path);
    return m ? m[1] : undefined;
  }

  export function handleCompactSession(sessionID: string, res: http.ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-OpenCode-Remote": "compact",
    });
    res.end(renderCompactShell(sessionID));
  }
  ```

- [ ] **Step 3: Wire the route in `index.ts`.**

  Update the import line:

  ```ts
  import { handleCompactStatic, handleCompactSession, matchCompactSessionPath } from "./compact/handlers.js";
  ```

  Add to the `http.createServer` block, before the static handler:

  ```ts
  if (req.method === "GET") {
    const compactSessionID = matchCompactSessionPath(req.url);
    if (compactSessionID) {
      handleCompactSession(compactSessionID, res);
      return;
    }
  }
  ```

- [ ] **Step 4: Build and verify the shell serves.**

  Run:
  ```bash
  npm run build && .\stop.ps1; .\start-hidden.ps1
  ```
  Wait 10 seconds, then probe (replace `ses_xxx` with an actual session id from `curl http://localhost:4096/session | python -c "import sys,json; print(json.load(sys.stdin)[0]['id'])"`):

  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9223/c/session/ses_xxx
  curl -s http://localhost:9223/c/session/ses_xxx | grep -o 'data-session-id="[^"]*"'
  ```
  Expected: `200` and `data-session-id="ses_xxx"`.

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/server/src/compact/shell.ts packages/server/src/compact/handlers.ts packages/server/src/index.ts
  git commit -m "$(cat <<'EOF'
  feat(compact): add /c/session/:id shell handler

  Renders the HTML shell for the compact session view with sessionID
  baked into a data attribute. Loads /c/static/compact.css and
  /c/static/compact.js; compact.js does all API fetches client-side.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 4: Port the mockup CSS into `compact.css`

**Files:**

- Create: `packages/server/static/compact.css`

- [ ] **Step 1: Copy the inline `<style>` block from `mockups/compact-mockup.html` (everything between `<style>` and `</style>`) into a new file.**

  Write to `packages/server/static/compact.css`. **Delete** these blocks from the copy (they are mockup-only):

  - The `.frame-wrap`, `.frame-label`, `.frame`, `.frame::before` blocks (both the small-screen default and the `@media (min-width: 760px) and (min-height: 1020px)` overrides for them).
  - The `.switcher` block and its big-screen media-query overrides.
  - The `.kb-placeholder` block (the OS keyboard simulator — the real OS keyboard, not the placeholder, handles this in production).

  Replace them with these production rules at the top of the file:

  ```css
  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    height: 100%;
    overflow: hidden;
  }
  body { height: 100vh; }
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    background: var(--bg);
  }
  ```

  **Keep** everything else verbatim (`:root` palette, `*` reset, `.app-header`, `.header-back`, `.model-chip`, `.messages`, `.msg*`, `.tool`, `.cursor`, `.scroll-chip`, `.attach-row`, `.input-bar`, `.icon-btn`, `.send-btn`, `.stop-btn`, `.compose`, `.picker*`, `.trust-row`, `.toggle`, `.provider-group`, `.model-row`, `.variants`, `.variant-pill`).

  Add this new block at the end (toast — not in mockup, needed for error UX):

  ```css
  .toast {
    position: absolute;
    left: 50%;
    bottom: 80px;
    transform: translateX(-50%);
    background: var(--surface-hi);
    border: 1px solid var(--border-hi);
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 13px;
    color: var(--text);
    box-shadow: 0 8px 24px -8px rgba(0,0,0,.6);
    z-index: 300;
    max-width: 80vw;
    text-align: center;
  }
  .toast.error { border-color: var(--danger); color: var(--danger); }
  ```

- [ ] **Step 2: Verify it serves.**

  Run:
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9223/c/static/compact.css
  ```
  Expected: `200`.

- [ ] **Step 3: Commit.**

  ```bash
  git add packages/server/static/compact.css
  git commit -m "$(cat <<'EOF'
  feat(compact): add compact.css ported from approved mockup

  Drops mockup-only chrome (device frame, state switcher, keyboard
  placeholder). Adds a toast style for error UX. Color palette and
  component styles are pixel-locked to the spec's Visual Reference.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 5: `compact.js` skeleton + history fetch + render

**Files:**

- Create: `packages/server/static/compact.js`

- [ ] **Step 1: Write the initial module.**

  Write to `packages/server/static/compact.js`:

  ```js
  // ─── State ─────────────────────────────────────────────────
  const sessionID = document.body.dataset.sessionId;
  const els = {
    messages: document.getElementById("messages"),
    compose: document.getElementById("compose"),
    actionBtn: document.getElementById("actionBtn"),
    attachBtn: document.getElementById("attachBtn"),
    fileInput: document.getElementById("fileInput"),
    attachRow: document.getElementById("attachRow"),
    modelBtn: document.getElementById("modelBtn"),
    modelName: document.getElementById("modelName"),
    modelVariant: document.getElementById("modelVariant"),
    picker: document.getElementById("picker"),
    toast: document.getElementById("toast"),
    scrollChip: document.getElementById("scrollChip"),
    scrollChipCount: document.getElementById("scrollChipCount"),
  };

  marked.setOptions({ gfm: true, breaks: true });

  const HISTORY_LIMIT = 30;

  // ─── Markdown + safety ─────────────────────────────────────
  function renderMarkdown(text) {
    return marked.parse(text || "");
  }

  // ─── API helpers ───────────────────────────────────────────
  async function api(path, init) {
    const res = await fetch(path, init);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    return res.headers.get("content-type")?.includes("application/json")
      ? res.json()
      : res.text();
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString("zh-Hant", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  // ─── Rendering ─────────────────────────────────────────────
  // Bag of currently rendered message DOM nodes, keyed by message id.
  const messageNodes = new Map();

  function ensureMessageNode(message) {
    let node = messageNodes.get(message.id);
    if (node) return node;
    node = document.createElement("div");
    node.className = "msg";
    node.dataset.messageId = message.id;
    const head = document.createElement("div");
    head.className = "msg-head";
    const role = message.role === "user" ? "user" : "ai";
    const roleLabel = message.role === "user" ? "Kevin" : "AI";
    head.innerHTML = `<span class="msg-role ${role}">${roleLabel}</span><span class="msg-time">· ${fmtTime(message.time?.created ?? Date.now())}</span>`;
    const body = document.createElement("div");
    body.className = "msg-body";
    node.append(head, body);
    els.messages.appendChild(node);
    messageNodes.set(message.id, node);
    return node;
  }

  function renderMessage(message) {
    const node = ensureMessageNode(message);
    const body = node.querySelector(".msg-body");
    // Build content from parts: text → markdown, tool → row, file → image
    body.innerHTML = "";
    let aggregateText = "";
    for (const part of message.parts ?? []) {
      if (part.type === "text") {
        aggregateText += (aggregateText ? "\n\n" : "") + (part.text ?? "");
      }
    }
    if (aggregateText) {
      const md = document.createElement("div");
      md.innerHTML = renderMarkdown(aggregateText);
      body.appendChild(md);
    }
    for (const part of message.parts ?? []) {
      if (part.type === "tool") {
        const row = document.createElement("div");
        row.className = "tool";
        const name = part.tool ?? part.name ?? "tool";
        const detail = summarizeTool(part);
        row.innerHTML = `<span class="tool-icon">🔧</span><span class="tool-name">${escapeHTML(name)}</span><span class="tool-detail">${detail ? "· " + escapeHTML(detail) : ""}</span>`;
        body.appendChild(row);
      } else if (part.type === "file" && (part.mime ?? "").startsWith("image/")) {
        const img = document.createElement("img");
        img.src = part.url;
        img.alt = part.filename ?? "";
        img.style.maxWidth = "240px";
        img.style.maxHeight = "240px";
        img.style.borderRadius = "8px";
        img.style.margin = "6px 0";
        img.style.display = "block";
        body.appendChild(img);
      }
    }
  }

  function summarizeTool(part) {
    const name = part.tool ?? part.name ?? "";
    const input = part.input ?? part.args ?? {};
    if (name === "edit" || name === "write") {
      return input.path ?? input.file ?? input.filename ?? "";
    }
    if (name === "bash") {
      const cmd = input.command ?? "";
      return cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd;
    }
    if (name === "read" || name === "grep" || name === "glob") {
      return input.path ?? input.pattern ?? input.file ?? "";
    }
    return "";
  }

  function escapeHTML(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ─── History ───────────────────────────────────────────────
  async function loadHistory() {
    const messages = await api(`/session/${sessionID}/message?limit=${HISTORY_LIMIT}`);
    els.messages.innerHTML = "";
    messageNodes.clear();
    const list = Array.isArray(messages) ? messages : [];
    list.sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
    for (const m of list) renderMessage(m);
    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      els.messages.scrollTop = els.messages.scrollHeight;
    });
  }

  // ─── Boot ──────────────────────────────────────────────────
  (async function boot() {
    try {
      await loadHistory();
    } catch (err) {
      console.error(err);
      showToast("載入歷史失敗：" + err.message, "error");
    }
  })();

  function showToast(text, kind) {
    els.toast.textContent = text;
    els.toast.className = "toast" + (kind === "error" ? " error" : "");
    els.toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { els.toast.hidden = true; }, 4000);
  }
  ```

- [ ] **Step 2: Verify history renders.**

  Open `http://localhost:9223/c/session/<ses_xxx>` in a desktop browser (use a real session id). DevTools console should be clean. Recent messages should render with role labels, timestamps, and markdown.

  Take a screenshot or note any unrendered fields (tool rows, code blocks) for follow-up tasks.

- [ ] **Step 3: Verify the API shape matches our renderer.**

  In DevTools console on the loaded page:
  ```js
  fetch(`/session/${document.body.dataset.sessionId}/message?limit=3`).then(r=>r.json()).then(j=>console.log(JSON.stringify(j[0], null, 2)))
  ```
  Inspect the printed message. If `parts[].type` includes types we did not handle (e.g. `reasoning`, `step-start`, `agent`, `subtask`), note them — Task 7 (SSE) will handle them as they stream in, but if any are critical for history rendering, extend `renderMessage` here. **Be specific in any extensions — no placeholder cases.**

- [ ] **Step 4: Commit.**

  ```bash
  git add packages/server/static/compact.js
  git commit -m "$(cat <<'EOF'
  feat(compact): add compact.js skeleton with history rendering

  Loads recent 30 messages from /session/:id/message, renders each
  message's text parts via marked and tool parts as one-line rows.
  Establishes the message-node bag used by later tasks for SSE
  incremental updates.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 6: Auto-grow textarea + submit-on-Enter

**Files:**

- Modify: `packages/server/static/compact.js`

- [ ] **Step 1: Append the textarea behavior block.**

  Append to `packages/server/static/compact.js`:

  ```js
  // ─── Textarea: auto-grow + Enter submits, Shift+Enter newline ─
  function resizeCompose() {
    els.compose.style.height = "auto";
    els.compose.style.height = Math.min(els.compose.scrollHeight, 140) + "px";
  }
  els.compose.addEventListener("input", resizeCompose);
  els.compose.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      els.actionBtn.click();
    }
  });
  ```

- [ ] **Step 2: Verify in browser.**

  Reload the page. Type into the textarea; it should grow to a max of 140 px. Press Shift+Enter for a newline. Press Enter — the click handler fires (Task 8 makes it do something; for now it should error from `actionBtn` having no listener yet — that's fine).

- [ ] **Step 3: Commit.**

  ```bash
  git add packages/server/static/compact.js
  git commit -m "$(cat <<'EOF'
  feat(compact): auto-grow textarea and Enter-to-submit

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 7: Subscribe to `/event` SSE and update messages in place

**Files:**

- Modify: `packages/server/static/compact.js`

- [ ] **Step 1: Inspect actual SSE event shapes.**

  In a DevTools console on a loaded compact page:
  ```js
  const es = new EventSource("/event");
  es.onmessage = (e) => console.log(JSON.parse(e.data));
  // Send a prompt via the native SPA in another tab, watch events for ~30s, then es.close()
  ```

  Identify the event types relevant to compact:
  - `message.updated` (or similar) — message part added/changed
  - `message.completed` / `message.aborted` — streaming finished
  - `session.updated` — model changed, title changed
  - Any others that affect the visible UI

  Write the exact event names you saw into the comment block at the top of the Step 2 code.

- [ ] **Step 2: Append the SSE subscription.**

  Append to `packages/server/static/compact.js` (adjust event names to what you observed in Step 1):

  ```js
  // ─── SSE subscription ──────────────────────────────────────
  // Observed events (fill in from Step 1):
  //   - "message.updated"   → message parts changed; re-render full message
  //   - "message.completed" → streaming done; hide spinner
  //   - "session.updated"   → header model chip may need refresh
  let isStreaming = false;

  function setStreaming(state) {
    isStreaming = state;
    els.actionBtn.classList.toggle("send-btn", !state);
    els.actionBtn.classList.toggle("stop-btn", state);
    els.actionBtn.textContent = state ? "■" : "▶";
    els.actionBtn.setAttribute("aria-label", state ? "停止" : "送出");
  }

  function fetchMessage(messageID) {
    return api(`/session/${sessionID}/message/${messageID}`);
  }

  async function refreshMessage(messageID) {
    try {
      const m = await fetchMessage(messageID);
      if (m.sessionID && m.sessionID !== sessionID) return;
      renderMessage(m);
      maybeScrollOrShowChip();
    } catch (err) {
      console.error("refreshMessage failed", err);
    }
  }

  function dispatchEvent(typeFromHeader, payload) {
    const type = typeFromHeader ?? payload?.type ?? payload?.event;
    const data = payload?.properties ?? payload;
    const msgSessionID = data?.sessionID ?? data?.session?.id;
    if (msgSessionID && msgSessionID !== sessionID) return;
    const messageID = data?.messageID ?? data?.message?.id;

    switch (type) {
      case "message.updated":
      case "session.message.updated":
        if (messageID) refreshMessage(messageID);
        setStreaming(true);
        break;
      case "message.completed":
      case "session.message.completed":
      case "message.aborted":
      case "session.message.aborted":
      case "session.idle":
        if (messageID) refreshMessage(messageID);
        setStreaming(false);
        break;
      case "session.updated":
        refreshHeader();
        break;
    }
  }

  function connectSSE() {
    const es = new EventSource("/event");
    // Catch both anonymous (no event: header) and named events.
    es.addEventListener("message", (ev) => {
      try { dispatchEvent(undefined, JSON.parse(ev.data)); } catch { /* ignore */ }
    });
    for (const name of [
      "message.updated",
      "session.message.updated",
      "message.completed",
      "session.message.completed",
      "message.aborted",
      "session.message.aborted",
      "session.updated",
      "session.idle",
    ]) {
      es.addEventListener(name, (ev) => {
        let payload = null;
        try { payload = ev.data ? JSON.parse(ev.data) : null; } catch { /* ignore */ }
        dispatchEvent(name, payload ?? {});
      });
    }
    es.addEventListener("error", () => {
      // EventSource auto-reconnects. On reconnect, force a history pull to catch up.
      setTimeout(() => loadHistory().catch(() => {}), 1500);
    });
    return es;
  }
  let sse = connectSSE();

  // ─── Sticky scroll ─────────────────────────────────────────
  let scrollPendingCount = 0;
  function isNearBottom() {
    const el = els.messages;
    return el.scrollHeight - (el.scrollTop + el.clientHeight) < 50;
  }
  function maybeScrollOrShowChip() {
    if (isNearBottom()) {
      scrollPendingCount = 0;
      els.scrollChip.hidden = true;
      scrollToBottom();
    } else {
      scrollPendingCount += 1;
      els.scrollChipCount.textContent = String(scrollPendingCount);
      els.scrollChip.hidden = false;
    }
  }
  els.messages.addEventListener("scroll", () => {
    if (isNearBottom()) {
      scrollPendingCount = 0;
      els.scrollChip.hidden = true;
    }
  });
  els.scrollChip.addEventListener("click", () => {
    scrollPendingCount = 0;
    els.scrollChip.hidden = true;
    scrollToBottom();
  });

  // ─── Header refresh stub (Task 11 fills it in) ────────────
  async function refreshHeader() { /* implemented in Task 11 */ }
  ```

- [ ] **Step 3: Verify live streaming.**

  Open `http://localhost:9223/c/session/<ses_xxx>` in Chrome. In the native SPA (another tab), send a prompt to the same session. The compact page should reflect new tokens in real time.

  Verify:
  - Streaming starts → `actionBtn` switches to red ■ stop button
  - Streaming finishes → `actionBtn` switches back to ▶ send button
  - Scrolling up away from the bottom while streaming → `↓ N 則新訊息` chip appears with growing count
  - Tapping the chip → scrolls to bottom and chip disappears

- [ ] **Step 4: Commit.**

  ```bash
  git add packages/server/static/compact.js
  git commit -m "$(cat <<'EOF'
  feat(compact): subscribe to /event SSE and live-render messages

  EventSource auto-reconnects; on reconnect we force a history refetch
  to catch any events we missed. Implements sticky-scroll chip per the
  spec.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 8: Send text messages (fire-and-forget)

**Files:**

- Modify: `packages/server/static/compact.js`

- [ ] **Step 1: Add the send handler.**

  Append to `packages/server/static/compact.js`:

  ```js
  // ─── Send ──────────────────────────────────────────────────
  let currentModel = null;     // { providerID, modelID, variant }
  // Filled in Task 11. For now, leave null — the server falls back to session.model.

  async function sendMessage() {
    if (isStreaming) {
      // Treat the click as Stop in streaming state (handled in Task 10).
      return abortMessage();
    }
    const text = els.compose.value.trim();
    const attachments = pendingAttachments.slice();
    if (!text && attachments.length === 0) return;

    const parts = [];
    if (text) parts.push({ type: "text", text });
    for (const a of attachments) {
      parts.push({ type: "file", mime: a.mime, url: a.dataUrl, filename: a.name });
    }
    const payload = { parts };
    if (currentModel) {
      payload.model = { providerID: currentModel.providerID, modelID: currentModel.modelID };
      if (currentModel.variant) payload.variant = currentModel.variant;
    }

    // Optimistic UI: clear input + attachments, show streaming state.
    els.compose.value = "";
    resizeCompose();
    clearAttachments();
    setStreaming(true);

    // Measure how long the POST takes — if >5s, switch to noReply or prompt_async path.
    const t0 = performance.now();
    try {
      await api(`/session/${sessionID}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const elapsed = performance.now() - t0;
      console.info(`[compact] POST /message returned in ${Math.round(elapsed)}ms`);
    } catch (err) {
      setStreaming(false);
      // Restore the user's input so they can retry.
      els.compose.value = text;
      pendingAttachments = attachments;
      renderAttachments();
      showToast("送出失敗：" + err.message, "error");
    }
  }

  els.actionBtn.addEventListener("click", () => {
    sendMessage();
  });

  // Task 9 / 10 stubs:
  let pendingAttachments = [];
  function clearAttachments() {
    pendingAttachments = [];
    els.attachRow.innerHTML = "";
    els.attachRow.hidden = true;
  }
  function renderAttachments() { /* Task 9 */ }
  async function abortMessage() { /* Task 10 */ }
  ```

- [ ] **Step 2: Verify text send works end-to-end.**

  Reload the compact page. Type "test from compact" and press Enter (or click ▶). Within 100ms the input clears and ▶ becomes ■.

  Confirm:
  - Within 1–2s, the user message appears in the list
  - SSE delivers the assistant's streamed reply
  - DevTools console logs `[compact] POST /message returned in NNms` — record the number

- [ ] **Step 3: Decide endpoint shape based on measured latency.**

  If the logged `POST /message` returned in <500 ms, the message endpoint is async — no change needed. ✅
  If it blocked until the assistant finished (5+ seconds for a substantive reply), switch the call:

  Modify the `await api(...)` line to set `noReply: true` in the payload OR change the path to `/session/${sessionID}/prompt_async`. Test both with the OpenCode doc at `curl http://localhost:4096/doc` first. Pick whichever returns immediately.

  Record the chosen path in a comment above the `await api(...)` line and update the spec's `Note on the message endpoint` paragraph with the actual finding.

- [ ] **Step 4: Verify true fire-and-forget.**

  Send a substantive prompt that triggers a long assistant reply (e.g., "explain the proxy architecture in detail"). Immediately close the browser tab. Wait 30 seconds. Re-open `http://localhost:9223/c/session/<id>`. The assistant message should now be complete (or still streaming if very long). **This is the core acceptance test for the whole feature.**

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/server/static/compact.js
  git commit -m "$(cat <<'EOF'
  feat(compact): send text messages (fire-and-forget)

  POST /session/:id/message returns within ~Xms (filled in by Step 3).
  Optimistic UI clears input immediately and toggles to streaming.
  Closing the browser mid-stream does not stop the agent loop — the
  next visit shows the completed result.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 9: Image attachments (FileReader → data URL)

**Files:**

- Modify: `packages/server/static/compact.js`

- [ ] **Step 1: Replace the `pendingAttachments` stubs with real logic.**

  Replace the existing `let pendingAttachments = [];`, `clearAttachments`, and `renderAttachments` block from Task 8 with this expanded version:

  ```js
  // ─── Attachments ───────────────────────────────────────────
  let pendingAttachments = [];
  const MAX_BYTES_PER_FILE = 5 * 1024 * 1024;   // 5 MB
  const MAX_TOTAL_BYTES = 20 * 1024 * 1024;     // 20 MB

  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";  // allow same file twice
    for (const f of files) addAttachment(f);
  });

  function addAttachment(file) {
    if (!file.type.startsWith("image/")) {
      showToast("僅支援圖片：" + file.name, "error");
      return;
    }
    if (file.size > MAX_BYTES_PER_FILE) {
      showToast(`圖片太大（>5MB）：${file.name}`, "error");
      return;
    }
    const totalAfter = pendingAttachments.reduce((s, a) => s + a.size, 0) + file.size;
    if (totalAfter > MAX_TOTAL_BYTES) {
      showToast("附件總量超過 20MB", "error");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingAttachments.push({
        name: file.name,
        mime: file.type,
        size: file.size,
        dataUrl: reader.result,
      });
      renderAttachments();
    };
    reader.onerror = () => showToast("讀取失敗：" + file.name, "error");
    reader.readAsDataURL(file);
  }

  function renderAttachments() {
    els.attachRow.innerHTML = "";
    if (pendingAttachments.length === 0) {
      els.attachRow.hidden = true;
      return;
    }
    els.attachRow.hidden = false;
    pendingAttachments.forEach((a, i) => {
      const thumb = document.createElement("div");
      thumb.className = "attach-thumb";
      thumb.innerHTML = `<img src="${a.dataUrl}" alt="" /><span class="x" data-i="${i}">×</span>`;
      els.attachRow.appendChild(thumb);
    });
  }
  els.attachRow.addEventListener("click", (e) => {
    const x = e.target.closest(".x");
    if (!x) return;
    const i = Number(x.dataset.i);
    pendingAttachments.splice(i, 1);
    renderAttachments();
  });

  function clearAttachments() {
    pendingAttachments = [];
    renderAttachments();
  }
  ```

- [ ] **Step 2: Verify.**

  In the compact page, tap 📎 → pick a JPEG/PNG. The thumbnail appears in the attach row. Send. Confirm the message appears in OpenCode (check the native SPA in another tab). Verify the image renders in the compact view too (Task 5's `renderMessage` already handles `type: "file"`).

- [ ] **Step 3: Verify the 5 MB guard.**

  Try to attach a >5 MB file. A red toast should appear, no thumbnail added.

- [ ] **Step 4: Commit.**

  ```bash
  git add packages/server/static/compact.js
  git commit -m "$(cat <<'EOF'
  feat(compact): image attachments via FileReader data URLs

  5 MB per-file and 20 MB total caps enforced client-side. Thumbnails
  render above the input bar; tapping × removes one. Sent as
  FilePartInput entries in the POST /message parts array — no separate
  upload endpoint involved.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 10: Stop button (abort)

**Files:**

- Modify: `packages/server/static/compact.js`

- [ ] **Step 1: Replace the `abortMessage` stub with real logic.**

  Replace the `async function abortMessage() { /* Task 10 */ }` line with:

  ```js
  async function abortMessage() {
    try {
      await api(`/session/${sessionID}/abort`, { method: "POST" });
      setStreaming(false);
    } catch (err) {
      showToast("中止失敗：" + err.message, "error");
    }
  }
  ```

- [ ] **Step 2: Verify.**

  Send a prompt that produces a long-running response. While the ■ Stop button is showing, tap it. The assistant should stop mid-stream; SSE delivers a `message.aborted` event; the button reverts to ▶.

- [ ] **Step 3: Commit.**

  ```bash
  git add packages/server/static/compact.js
  git commit -m "$(cat <<'EOF'
  feat(compact): abort button

  Sends POST /session/:id/abort. State flips back via the SSE
  message.aborted event handler from Task 7.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 11: Model + variant picker overlay

**Files:**

- Modify: `packages/server/static/compact.js`

- [ ] **Step 1: Append picker code.**

  Append to `packages/server/static/compact.js`:

  ```js
  // ─── Model picker ──────────────────────────────────────────
  let providersCache = null;
  let defaultModelFromConfig = null;

  async function loadProviders() {
    if (providersCache) return providersCache;
    const r = await api("/provider");
    providersCache = Array.isArray(r?.all) ? r.all : (Array.isArray(r) ? r : []);
    return providersCache;
  }

  async function loadDefaultModelFromConfig() {
    if (defaultModelFromConfig !== null) return defaultModelFromConfig;
    try {
      const config = await api("/config");
      // OpenCode config model is typically "providerID/modelID"
      if (typeof config?.model === "string" && config.model.includes("/")) {
        const [providerID, modelID] = config.model.split("/", 2);
        defaultModelFromConfig = { providerID, modelID };
      }
    } catch { /* ignore */ }
    return defaultModelFromConfig;
  }

  async function refreshHeader() {
    try {
      // Historical draft only. The implemented client now reads the latest
      // user-message model metadata because session.model is unreliable.
      const messages = await api(`/session/${sessionID}/message?limit=30`);
      // This helper normalizes modelID/id and top-level/nested variant, selects
      // by created time with batch last-wins ties, and returns messageID so
      // equal-timestamp individual events can trigger a latest-only full-history
      // refresh instead of guessing their order from message IDs.
      const selection = latestUserMessageSelection(messages);
      if (selection) {
        currentModel = selection.model;
        latestModelMessageCreated = selection.created;
        latestModelMessageID = selection.messageID;
      } else {
        const fallback = await loadDefaultModelFromConfig();
        if (fallback) currentModel = { ...fallback, variant: null };
      }
      if (currentModel) {
        els.modelName.textContent = currentModel.modelID;
        els.modelVariant.textContent = currentModel.variant ? `· ${currentModel.variant}` : "";
      } else {
        els.modelName.textContent = "(no model)";
        els.modelVariant.textContent = "";
      }
    } catch (err) {
      console.error("refreshHeader failed", err);
    }
  }

  async function openPicker() {
    els.picker.hidden = false;
    els.picker.innerHTML = `
      <div class="picker-header">
        <h2>Model &amp; Settings</h2>
        <button class="picker-close" id="pickerClose" type="button">✕</button>
      </div>
      <div class="picker-body" id="pickerBody">
        <div class="trust-row">
          <div class="trust-label">
            <div class="t1">🔓 Trust mode</div>
            <div class="t2">Auto-allow tool calls (keep deny rules)</div>
          </div>
          <div class="toggle off" id="trustToggle"></div>
        </div>
        <div id="providersList">載入中…</div>
      </div>`;
    document.getElementById("pickerClose").addEventListener("click", closePicker);
    document.getElementById("trustToggle").addEventListener("click", toggleTrust);

    try {
      const providers = await loadProviders();
      renderProviders(providers);
    } catch (err) {
      document.getElementById("providersList").textContent = "載入失敗：" + err.message;
    }
    await refreshTrustToggle();
  }

  function closePicker() { els.picker.hidden = true; }

  els.modelBtn.addEventListener("click", openPicker);

  function renderProviders(providers) {
    const list = document.getElementById("providersList");
    list.innerHTML = "";
    for (const provider of providers) {
      const models = Object.values(provider.models ?? {});
      if (models.length === 0) continue;
      const group = document.createElement("div");
      group.className = "provider-group";
      const name = document.createElement("h3");
      name.className = "provider-name";
      name.textContent = provider.name ?? provider.id;
      group.appendChild(name);
      for (const m of models) {
        const row = document.createElement("div");
        row.className = "model-row";
        const variants = m.variants ? Object.keys(m.variants) : [];
        const isCurrent = currentModel && currentModel.providerID === provider.id && currentModel.modelID === m.id;
        let pills;
        if (variants.length > 0) {
          pills = variants.map((v) => {
            const active = isCurrent && currentModel.variant === v;
            return `<span class="variant-pill${active ? " active" : ""}" data-provider="${escapeHTML(provider.id)}" data-model="${escapeHTML(m.id)}" data-variant="${escapeHTML(v)}">${escapeHTML(v)}</span>`;
          }).join("");
        } else {
          const active = isCurrent && !currentModel.variant;
          pills = `<span class="variant-pill${active ? " active" : ""}" data-provider="${escapeHTML(provider.id)}" data-model="${escapeHTML(m.id)}" data-variant="">—</span>`;
        }
        row.innerHTML = `<div class="model-name">${escapeHTML(m.id)}</div><div class="variants">${pills}</div>`;
        group.appendChild(row);
      }
      list.appendChild(group);
    }
    list.addEventListener("click", (e) => {
      const pill = e.target.closest(".variant-pill");
      if (!pill) return;
      currentModel = {
        providerID: pill.dataset.provider,
        modelID: pill.dataset.model,
        variant: pill.dataset.variant || null,
      };
      els.modelName.textContent = currentModel.modelID;
      els.modelVariant.textContent = currentModel.variant ? `· ${currentModel.variant}` : "";
      closePicker();
    });
  }

  // Trust mode stubs filled in Task 12.
  async function toggleTrust() { /* Task 12 */ }
  async function refreshTrustToggle() { /* Task 12 */ }

  // Run header refresh on boot.
  refreshHeader();
  ```

- [ ] **Step 2: Verify.**

  Reload. The header chip should now show `gpt-5.5 · medium` (or whatever the session's last model was). Tap it — picker opens, shows providers grouped, with the current model/variant highlighted in solid emerald.

  Select a different model/variant. The chip updates. Send a message with the new selection. After the message arrives, refresh — the chip should still show the new model because the latest shared user-message metadata records it.

- [ ] **Step 3: Commit.**

  ```bash
  git add packages/server/static/compact.js
  git commit -m "$(cat <<'EOF'
  feat(compact): model + variant picker overlay

  Reads providers from /provider and preselects from the latest shared
  user-message metadata. Legacy compact storage and /config.model are
  fallback sources only when history has no model metadata.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 12: Trust mode toggle

**Files:**

- Modify: `packages/server/static/compact.js`

**Decision point:** pre-flight P4 determined whether `PATCH /session/:id` accepts the `permission` field. If yes, use Step 1A. If no, use Step 1B.

- [ ] **Step 1A (preferred — PATCH works): replace trust-mode stubs.**

  Replace the `async function toggleTrust()` and `async function refreshTrustToggle()` stubs with:

  ```js
  // The all-allow ruleset overrides "ask" verbatim and preserves the deny
  // patterns from opencode.json. Keep this list in sync with opencode.json
  // if the deny set changes there.
  const TRUST_PERMISSION = {
    edit: {
      "*": "allow",
      ".env": "deny",
      ".env.*": "deny",
      "*service-account*.json": "deny",
      "*credential*.json": "deny",
      "secrets/**": "deny",
      ".claude-memory/**": "deny",
      "**/.env": "deny",
      "**/.env.*": "deny",
      "**/*service-account*.json": "deny",
      "**/*credential*.json": "deny",
      "**/secrets/**": "deny",
      "**/.claude-memory/**": "deny",
    },
    bash: {
      "*": "allow",
      "git reset --hard*": "deny",
      "git push --force*": "deny",
      "git clean*": "deny",
      "Remove-Item *": "deny",
      "del *": "deny",
      "rmdir *": "deny",
      "* > .env*": "deny",
    },
    git_git_reset: "deny",
    git_git_clean: "deny",
    git_git_clear_working_dir: "deny",
    git_git_push: "allow",
    git_git_commit: "allow",
    "github_*": "allow",
    "filesystem_*": "allow",
    "fetch_*": "allow",
  };

  async function setTrustMode(on) {
    const payload = on ? { permission: TRUST_PERMISSION } : { permission: null };
    try {
      await api(`/session/${sessionID}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      showToast("Trust mode 切換失敗：" + err.message, "error");
      throw err;
    }
  }

  async function refreshTrustToggle() {
    try {
      const session = await api(`/session/${sessionID}`);
      const on = !!(session.permission && session.permission.edit && session.permission.edit["*"] === "allow");
      document.getElementById("trustToggle").classList.toggle("off", !on);
    } catch { /* ignore */ }
  }

  async function toggleTrust(e) {
    const el = e.currentTarget;
    const willBeOn = el.classList.contains("off");
    el.classList.toggle("off", !willBeOn);  // optimistic
    try {
      await setTrustMode(willBeOn);
    } catch {
      el.classList.toggle("off", willBeOn); // revert
    }
  }
  ```

  **Note:** The `github_*`, `filesystem_*`, `fetch_*` keys above are wildcards in opencode's permission grammar. If `PATCH /session` rejects wildcard keys, fall back to listing every specific permission as observed in `GET /session/:id.permission` after a manual edit through the native SPA.

- [ ] **Step 1B (fallback — PATCH does not accept `permission`): inject override into outgoing `POST /message`.**

  In this case, skip the `setTrustMode` PATCH approach. Instead, modify `sendMessage` from Task 8: when a `trustEnabled` UI flag is on, embed the `TRUST_PERMISSION` object into the message payload as `permission` (test whether the message endpoint accepts a permission override on the POST first — probe via `curl http://localhost:4096/doc | python -c ...`). Store the trust flag in `localStorage` keyed by sessionID. If neither path works, **stop** and re-open the spec — the spec must be revised before continuing.

- [ ] **Step 2: Verify.**

  Reload. Open picker. Toggle Trust mode. Send a prompt that requires a tool call (e.g., "edit packages/server/src/compact/handlers.ts and add a console.log"). The assistant should complete without prompting for approval.

  Repeat with Trust mode off — the assistant should now stall on the edit (or be denied if running headless). This proves the toggle works.

- [ ] **Step 3: Commit.**

  ```bash
  git add packages/server/static/compact.js
  git commit -m "$(cat <<'EOF'
  feat(compact): trust mode toggle in picker overlay

  Patches the session's permission ruleset to auto-allow tool calls
  while keeping deny patterns. Survives refreshes (state lives on the
  session record server-side).

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 13: Refresh-on-focus

**Files:**

- Modify: `packages/server/static/compact.js`

- [ ] **Step 1: Append the visibility handler.**

  Append to `packages/server/static/compact.js`:

  ```js
  // ─── Refresh on visibility return ──────────────────────────
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // The user might have been gone for a while; the SSE connection may
    // be stale. Reload history and reconnect SSE.
    loadHistory().catch((err) => console.warn("focus reload failed", err));
    try { sse.close(); } catch { /* noop */ }
    sse = connectSSE();
    refreshHeader();
  });
  ```

- [ ] **Step 2: Verify.**

  Open compact, send a prompt, switch to another tab. After the assistant is done, switch back. The completed message should be visible without manual refresh.

- [ ] **Step 3: Commit.**

  ```bash
  git add packages/server/static/compact.js
  git commit -m "$(cat <<'EOF'
  feat(compact): refresh history + reconnect SSE on tab focus

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 14: Update `/remote-sessions` card links to point at compact

**Files:**

- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Change the `href` in `handleRemoteSessions`.**

  In `packages/server/src/index.ts`, find:

  ```ts
  const path = `/${encodeDirSlug(session.directory)}/session/${session.id}`;
  ```

  Replace with:

  ```ts
  const path = `/c/session/${session.id}`;
  ```

  **Do not touch any other code in `handleRemoteSessions`.** Layout, sort order, filter — all stay.

- [ ] **Step 2: Build and verify.**

  ```bash
  npm run build && .\stop.ps1; .\start-hidden.ps1
  ```

  Wait 10s, then:
  ```bash
  curl -s http://localhost:9223/remote-sessions | grep -o 'href="[^"]*"' | head -3
  ```
  Expected: hrefs like `href="/c/session/ses_xxx"`.

  In a browser, open `/remote-sessions` and tap a card. It should now land on `/c/session/<id>` (the compact view), not the native SPA.

- [ ] **Step 3: Confirm Desktop SPA paths still work.**

  In a browser, navigate directly to `/<base64url(dir)>/session/<id>` (the native SPA URL). It should still load the native UI unchanged. The transparent proxy must not have been disturbed.

- [ ] **Step 4: Commit.**

  ```bash
  git add packages/server/src/index.ts
  git commit -m "$(cat <<'EOF'
  feat(compact): point /remote-sessions cards at /c/session/:id

  Native SPA paths (/<base64url(dir)>/session/:id) continue to work
  unchanged via the transparent proxy. Only the card href changes.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 15: `POST /c/new-session` route

**Files:**

- Modify: `packages/server/src/compact/handlers.ts`
- Modify: `packages/server/src/index.ts`

- [ ] **Step 1: Add the handler.**

  Append to `packages/server/src/compact/handlers.ts`:

  ```ts
  import { config as appConfig } from "../config.js";

  export async function handleCompactNewSession(res: http.ServerResponse): Promise<void> {
    try {
      const opencodeUrl = appConfig.opencodeUrl;
      const r = await fetch(`${opencodeUrl}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "compact" }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`OpenCode POST /session returned ${r.status}: ${body.slice(0, 200)}`);
      }
      const session = await r.json() as { id?: string };
      if (!session.id) throw new Error("OpenCode response missing session id");
      res.writeHead(303, {
        Location: `/c/session/${session.id}`,
        "Cache-Control": "no-store",
      });
      res.end();
    } catch (err) {
      console.error("[opencode-remote] /c/new-session failed:", err);
      res.writeHead(502, { "Cache-Control": "no-store" });
      res.end("Failed to create session");
    }
  }
  ```

- [ ] **Step 2: Wire the route.**

  Update the import in `packages/server/src/index.ts`:

  ```ts
  import {
    handleCompactStatic,
    handleCompactSession,
    handleCompactNewSession,
    matchCompactSessionPath,
  } from "./compact/handlers.js";
  ```

  Add to the `http.createServer` block, alongside the existing compact routes:

  ```ts
  if (req.method === "POST" && req.url === "/c/new-session") {
    void handleCompactNewSession(res);
    return;
  }
  ```

- [ ] **Step 3: Add a "+ 新 session" button to `/remote-sessions`.**

  In `handleRemoteSessions` in `index.ts`, find the `<header>` block and insert this button right before `</header>`:

  ```ts
  <form method="post" action="/c/new-session" style="margin-top:10px;">
    <button type="submit" style="background:#6366f1;color:#fff;border:none;border-radius:10px;padding:8px 14px;font-size:14px;cursor:pointer;">+ 新 session</button>
  </form>
  ```

- [ ] **Step 4: Build and verify.**

  ```bash
  npm run build && .\stop.ps1; .\start-hidden.ps1
  ```
  Wait 10s. Open `/remote-sessions`. Tap the `+ 新 session` button. Should land on `/c/session/<new id>` with an empty history.

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/server/src/compact/handlers.ts packages/server/src/index.ts
  git commit -m "$(cat <<'EOF'
  feat(compact): POST /c/new-session creates session + redirects

  Adds a + 新 session button to /remote-sessions that creates an
  empty session via OpenCode POST /session and 303-redirects to the
  compact view of the new id.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 16: End-to-end verification on real devices

**Files:** none modified — verification only.

- [ ] **Step 1: Desktop browser smoke test.**

  In a desktop Chrome window resized to 640×960:
  - Open `http://localhost:9223/remote-sessions`. Card list renders. Tap a card.
  - Compact view loads. Recent history visible, markdown formatted (headings, lists, code blocks, links). Tool rows render with 🔧 + name + detail.
  - Send a text prompt. User message appears immediately. ▶ → ■. SSE delivers assistant tokens.
  - Tap ■ mid-stream. Assistant stops.
  - Close tab mid-stream of a fresh prompt. Re-open the URL. The reply is complete.
  - Open picker. Change model + variant. Send. After response, refresh page → picker still preselects the new model.
  - Toggle Trust mode off. Send a prompt that needs an edit. The agent stalls.
  - Toggle Trust mode on. Send the same prompt. The agent completes without prompting.
  - Attach a JPEG, send. Image appears in the assistant's view (cross-check with the native SPA).

- [ ] **Step 2: iPhone landscape smoke test (Safari, 852×393).**

  Open `https://opencode.sisihome.org/remote-sessions` on an iPhone in landscape. Pick a session.
  - No horizontal scrollbar appears.
  - Header chip ("gpt-5.5 · medium" etc.) is not truncated.
  - Tapping the input area pulls up the OS keyboard. Messages remain readable in the remaining space.
  - Send a prompt. Streaming works. Stop works.
  - Picker overlay fills the viewport correctly with no overflow.

- [ ] **Step 3: RG DS / GammaOS DualStack smoke test (640×960 portrait).**

  Open `https://opencode.sisihome.org/remote-sessions` on the RG DS in DualStack mode. Pick a session.
  - Full 640×960 canvas used.
  - When keyboard appears, bottom 480px (lower screen) carries it; top 480px (upper screen) keeps showing messages and input affordances.
  - Send + stop + abort work via touch.

- [ ] **Step 4: Run repo-standard build checks.**

  ```bash
  npm run typecheck
  npm run build
  ```
  Expected: both pass.

- [ ] **Step 5: Update the spec's verification section.**

  Open `docs/superpowers/specs/2026-05-20-compact-remote-frontend-design.md` and replace the "## Verification" section's checkboxes with `[x]` reflecting what was actually verified, plus a note like:

  ```
  Verified on 2026-MM-DD against opencode v<x.y.z>. Latency of POST
  /session/:id/message measured at <NN>ms (async, no switch to
  prompt_async needed). PATCH /session/:id accepts permission field
  (trust mode uses the preferred path, not the proxy-injection fallback).
  ```

- [ ] **Step 6: Commit.**

  ```bash
  git add docs/superpowers/specs/2026-05-20-compact-remote-frontend-design.md
  git commit -m "$(cat <<'EOF'
  docs: record compact frontend verification evidence

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

### Task 17: Remove the mockup and the `/c-mockup` route

**Files:**

- Modify: `packages/server/src/index.ts`
- Delete: `mockups/compact-mockup.html`
- Delete: `mockups/` (if empty after the file removal)

- [ ] **Step 1: Remove the route registration.**

  In `packages/server/src/index.ts`, find and delete this block:

  ```ts
  if (req.method === "GET" && req.url === "/c-mockup") {
    sendCompactMockup(res);
    return;
  }
  ```

  And the entire `sendCompactMockup` function (added in the earlier mockup-serving commit).

  If `readFileSync`, `dirname`, `fileURLToPath`, and `join` are no longer used elsewhere in `index.ts`, also remove them from the imports. Run `npm run typecheck` to confirm — TypeScript reports unused imports if `noUnusedLocals` is on.

- [ ] **Step 2: Delete the mockup directory.**

  Run (PowerShell):
  ```powershell
  Remove-Item -Recurse -Force mockups
  ```

- [ ] **Step 3: Build and verify.**

  ```bash
  npm run build && .\stop.ps1; .\start-hidden.ps1
  ```
  Wait 10s. `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9223/c-mockup` should return `404`.

  `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:9223/c/session/<a real session id>` should still return `200`.

- [ ] **Step 4: Commit.**

  ```bash
  git add packages/server/src/index.ts
  git rm -r mockups
  git commit -m "$(cat <<'EOF'
  chore(compact): remove /c-mockup preview route and mockups dir

  The compact UI is now served at /c/session/:id and is the canonical
  reference for the visual design. The mockup-only preview is removed
  to keep the production surface clean.

  Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
  EOF
  )"
  ```

---

## Self-Review (do not skip)

After completing all tasks, the implementer runs through this checklist before declaring done:

1. **Spec coverage check:** Every "## Decisions" subsection in the spec maps to a completed task:
   - Decision 1 (Architecture: server-rendered HTML + vanilla JS, no build) — Tasks 1–5
   - Decision 2 (URL routing table) — Tasks 2, 3, 14, 15
   - Decision 3 (Reuse /remote-sessions) — Task 14
   - Decision 4 (Fire-and-forget) — Task 8 (and core behavior verified in Task 16)
   - Decision 5 (Trust mode) — Task 12
   - Decision 6 (Model + variant picker) — Task 11
   - Decision 7 (Image upload) — Task 9
   - Decision 8 (Markdown rendering) — Tasks 1, 5
   - Decision 9 (History last 30, sticky-scroll) — Tasks 5, 7
   - Decision 10 (Tool call one-line summary) — Task 5

2. **Verification check:** Every numbered item in the spec's "## Verification" section was exercised in Task 16. Any item that could not be verified is documented with the reason.

3. **No-build-step check:** `start.ps1`, `start-hidden.ps1`, `Dockerfile`, Caddyfile are unchanged. `npm run dev` still works for hot-reload of the server (static files are read at request time, so no rebuild needed for CSS/JS edits — only TS changes need `npm run build`).

4. **Native SPA untouched:** The Desktop SPA path `/<base64url(dir)>/session/:id` still loads the native UI. The transparent proxy was not modified beyond adding new `/c/*` route arms before the final `proxy(req, res)` call.

5. **Secrets check:** No tokens, paths, or session ids are hard-coded. `GITHUB_TOKEN` is not referenced in compact code at all.

6. **Mockup removed:** `mockups/` directory and `/c-mockup` route do not exist anymore. (Task 17.)

If any of these fail, fix before declaring the plan complete. If the fix is non-trivial, add a follow-up task at the end of this plan.
