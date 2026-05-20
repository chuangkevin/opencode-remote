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

// The OpenCode message API wraps metadata inside an `info` sub-object:
// { info: { id, role, time: { created }, ... }, parts: [...] }
// All helpers below extract from `message.info` rather than message root.

function ensureMessageNode(message) {
  const info = message.info ?? {};
  const id = info.id;
  let node = messageNodes.get(id);
  if (node) return node;
  node = document.createElement("div");
  node.className = "msg";
  node.dataset.messageId = id;
  const head = document.createElement("div");
  head.className = "msg-head";
  const role = info.role === "user" ? "user" : "ai";
  const roleLabel = info.role === "user" ? "Kevin" : "AI";
  const created = info.time?.created ?? Date.now();
  head.innerHTML = `<span class="msg-role ${role}">${roleLabel}</span><span class="msg-time">· ${fmtTime(created)}</span>`;
  const body = document.createElement("div");
  body.className = "msg-body";
  node.append(head, body);
  els.messages.appendChild(node);
  messageNodes.set(id, node);
  return node;
}

function renderMessage(message) {
  const node = ensureMessageNode(message);
  const body = node.querySelector(".msg-body");
  body.innerHTML = "";

  // Aggregate all text parts into one markdown block (preserves paragraph order).
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
      // Tool call/result: state.input holds args, state.output holds result text.
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
    // step-start / step-finish: pure metadata boundaries, no visible output.
    // reasoning: internal chain-of-thought, not shown to user.
  }
}

function summarizeTool(part) {
  const name = part.tool ?? part.name ?? "";
  // Tool args live inside state.input (API shape from OpenCode).
  const input = part.state?.input ?? part.input ?? part.args ?? {};
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
  list.sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0));
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

// ─── SSE subscription ──────────────────────────────────────
// Observed events from /event (probed 2026-05-20, OpenCode v1.14.30):
//   All events arrive as generic SSE `data:` lines (no named `event:` header).
//   The JSON `type` field distinguishes them:
//
//   "message.updated"       → message info updated (user or assistant).
//                             messageID at properties.info.id
//                             sessionID at properties.sessionID (and properties.info.sessionID)
//   "message.part.updated"  → a part was added or fully updated (streaming chunk or final).
//                             messageID at properties.part.messageID
//                             sessionID at properties.sessionID
//   "message.part.delta"    → incremental text delta during streaming.
//                             messageID at properties.messageID
//                             partID   at properties.partID
//                             field    at properties.field ("text")
//                             delta    at properties.delta
//   "session.status"        → status.type = "busy" | "idle"
//                             sessionID at properties.sessionID
//   "session.idle"          → clean "streaming complete" signal (fires after last busy→idle).
//                             sessionID at properties.sessionID
//   "session.updated"       → session title / metadata changed (use for header refresh).
//                             sessionID at properties.sessionID
//   "server.connected"      → initial handshake (no sessionID)
//   "server.heartbeat"      → keepalive (no sessionID)

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
    // m is shaped { info: { id, sessionID, role, time, ... }, parts: [...] }
    if (m.info?.sessionID && m.info.sessionID !== sessionID) return;
    renderMessage(m);
    maybeScrollOrShowChip();
  } catch (err) {
    console.error("refreshMessage failed", err);
  }
}

// Track which messageIDs we have seen a refresh request for during streaming
// so we debounce rapid part.delta floods (refresh once per animation frame).
const _pendingRefresh = new Set();

function scheduleRefresh(messageID) {
  if (_pendingRefresh.has(messageID)) return;
  _pendingRefresh.add(messageID);
  requestAnimationFrame(() => {
    _pendingRefresh.delete(messageID);
    refreshMessage(messageID);
  });
}

// Accumulate in-progress delta text so we can optimistically render without
// fetching the server for every keystroke.
const _deltaBuffers = new Map(); // messageID+partID → accumulated text

function applyDelta(props) {
  const { messageID, partID, field, delta } = props;
  if (!messageID || field !== "text" || !delta) return;
  const key = `${messageID}::${partID}`;
  const prev = _deltaBuffers.get(key) ?? "";
  const next = prev + delta;
  _deltaBuffers.set(key, next);
  // Find the existing message node and patch it optimistically.
  const msgNode = messageNodes.get(messageID);
  if (!msgNode) {
    // Message node not yet in DOM — schedule a full refresh instead.
    scheduleRefresh(messageID);
    return;
  }
  // Find or create the streaming text element.
  const body = msgNode.querySelector(".msg-body");
  let streamEl = body.querySelector(`[data-stream-part="${partID}"]`);
  if (!streamEl) {
    streamEl = document.createElement("div");
    streamEl.dataset.streamPart = partID;
    body.appendChild(streamEl);
  }
  streamEl.innerHTML = renderMarkdown(next);
  maybeScrollOrShowChip();
}

function dispatchSSEEvent(type, props) {
  // Filter by sessionID when present.
  const eventSessionID = props?.sessionID ?? props?.info?.sessionID;
  if (eventSessionID && eventSessionID !== sessionID) return;

  // Extract messageID from the various shapes we observed:
  //   message.updated:      props.info.id
  //   message.part.updated: props.part.messageID
  //   message.part.delta:   props.messageID
  const messageID =
    props?.info?.id ??
    props?.part?.messageID ??
    props?.messageID ??
    null;

  switch (type) {
    case "message.updated":
      // Fires for user message immediately (before AI starts) and again when
      // the assistant message completes. Refresh to get authoritative content.
      if (messageID) scheduleRefresh(messageID);
      break;

    case "message.part.updated": {
      // A part was fully written (streaming chunk or final). Full refresh gets
      // the part from the server so we replace optimistic delta text with
      // authoritative content.
      const partID = props?.part?.id;
      if (partID) {
        // Clear our delta buffer for this part — server now has the truth.
        _deltaBuffers.delete(`${messageID}::${partID}`);
      }
      if (messageID) scheduleRefresh(messageID);
      setStreaming(true);
      break;
    }

    case "message.part.delta":
      // Incremental text during streaming — apply optimistically without fetching.
      setStreaming(true);
      applyDelta(props);
      break;

    case "session.status": {
      const statusType = props?.status?.type;
      if (statusType === "busy") setStreaming(true);
      else if (statusType === "idle") setStreaming(false);
      break;
    }

    case "session.idle":
      // Definitive "all streaming done" signal. Do a final refresh of any
      // message we have buffered but haven't flushed yet.
      setStreaming(false);
      _deltaBuffers.clear();
      break;

    case "session.updated":
      refreshHeader();
      break;

    default:
      // Unknown event — log once per type for diagnostics.
      if (!dispatchSSEEvent._seen) dispatchSSEEvent._seen = new Set();
      if (!dispatchSSEEvent._seen.has(type)) {
        dispatchSSEEvent._seen.add(type);
        console.debug("[compact] unknown SSE event:", type, props);
      }
      break;
  }
}

function connectSSE() {
  const es = new EventSource("/event");
  // All OpenCode events arrive as generic (unnamed) SSE messages — no
  // `event:` header is used; only the `data:` field carries JSON with `type`.
  es.addEventListener("message", (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      const type = payload?.type;
      const props = payload?.properties ?? {};
      if (type) dispatchSSEEvent(type, props);
    } catch {
      /* ignore non-JSON heartbeat noise */
    }
  });
  es.addEventListener("error", () => {
    // EventSource will auto-reconnect. On reconnect we do a full history pull
    // to catch any events we missed while disconnected.
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
