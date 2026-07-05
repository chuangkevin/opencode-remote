// ─── State ─────────────────────────────────────────────────
const sessionID = document.body.dataset.sessionId;
const defaultDirectory = document.body.dataset.directory || "";
const els = {
  messages: document.getElementById("messages"),
  compose: document.getElementById("compose"),
  actionBtn: document.getElementById("actionBtn"),
  stopBtn: document.getElementById("stopBtn"),
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
let isStreaming = false;
let currentDirectory = defaultDirectory;
const STREAMING_POLL_INTERVAL_MS = 5_000;
let streamingPollTimer = null;
let streamingPollInFlight = false;
const COMPACT_DEFAULT_MODEL = { providerID: "opencode", modelID: "deepseek-v4-pro", variant: "max" };

function normalizePromptModel(model) {
  const providerID = typeof model?.providerID === "string" ? model.providerID : "";
  const rawModelID = model?.modelID ?? model?.id;
  const modelID = typeof rawModelID === "string" ? rawModelID : "";
  if (!providerID || !modelID) return null;
  return { providerID, modelID, variant: model.variant ?? null };
}

function compactPromptModel(model) {
  return normalizePromptModel(model);
}

function setCurrentModel(model) {
  currentModel = compactPromptModel(model) ?? { ...COMPACT_DEFAULT_MODEL };
  els.modelName.textContent = currentModel.modelID;
  els.modelVariant.textContent = currentModel.variant && currentModel.variant !== "none"
    ? `· ${currentModel.variant}`
    : "";
}

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
  // 204 No Content (and any response with empty body) returns null.
  // This is needed by prompt_async (T8) and abort (T10) which both return 204.
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") ?? "";
  const text = await res.text().catch(() => "");
  if (!text) return null;
  if (ct.includes("application/json")) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

function fmtTime(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString("zh-Hant", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// ─── Rendering ─────────────────────────────────────────────
// Bag of currently rendered message DOM nodes, keyed by message id.
const messageNodes = new Map();

// Permission auto-accept dedup (so a re-broadcast event does not retry POST).
const _autoAcceptedPermissions = new Set();

// Inline question cards mounted under els.messages, keyed by question id.
const questionNodes = new Map();
let pendingQuestionDrainTimer = null;

// Persisted prompt queue (see the "Prompt queue" section below). Hoisted
// here so loadHistory() can clear queueNodes / re-render queue without
// caring about module evaluation order.
const QUEUE_KEY = `compact-queue:${sessionID}`;
let queue = (() => {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
  catch { return []; }
})();
const queueNodes = new Map();

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
  const info = message.info ?? {};
  const isUser = info.role === "user";
  // When the first real user message renders, drop any optimistic placeholders.
  if (isUser) removeOptimisticUserMessages();

  const node = ensureMessageNode(message);
  const body = node.querySelector(".msg-body");
  body.innerHTML = "";

  let hasContent = false;

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
    hasContent = true;
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
      hasContent = true;
      if (name === "question") schedulePendingQuestionDrain();
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
      hasContent = true;
    }
    // step-start / step-finish: pure metadata boundaries, no visible output.
    // reasoning: internal chain-of-thought, not shown to user.
  }

  // While the assistant is still thinking (no visible parts yet) show a typing
  // indicator so the user knows the agent is alive. Removed once a delta or
  // any visible part arrives — applyDelta clears it explicitly too.
  if (!isUser && !hasContent && isStreaming) {
    const ind = document.createElement("div");
    ind.className = "thinking-indicator";
    ind.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(ind);
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
  // The question cards and queued-prompt nodes we mounted under
  // els.messages were wiped; clear the caches so drainPendingInteractive
  // and the boot-time queue renderer can re-mount them.
  questionNodes.clear();
  queueNodes.clear();
  const list = Array.isArray(messages) ? messages : [];
  list.sort((a, b) => (a.info?.time?.created ?? 0) - (b.info?.time?.created ?? 0));
  for (const m of list) renderMessage(m);
  // Re-render any prompts still in the queue so they survive a history
  // refresh (loadHistory is also called on visibilitychange).
  for (const item of queue) renderQueueItem(item);
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
    await refreshBusyStatus();
    await loadHistory();
    // Render any prompts queued before the page was reloaded.
    for (const item of queue) renderQueueItem(item);
    if (queue.length > 0) scrollToBottom();
  } catch (err) {
    console.error(err);
    showToast("載入歷史失敗：" + err.message, "error");
  }
  // Load session meta + model in parallel — does not block rendering history.
  refreshHeader().catch((err) => console.warn("refreshHeader boot:", err));
  // Drain any pending permission asks / questions that arrived before this
  // tab loaded (e.g. AI started while the user was away).
  drainPendingInteractive().catch((err) => console.warn("drainPendingInteractive:", err));
  // Flush any local prompts left by an older build or failed request. The
  // server owns busy-session queueing, so this no longer waits for idle.
  if (queue.length > 0) {
    setTimeout(() => {
      refreshBusyStatus()
        .then(() => drainQueueIfIdle())
        .catch((err) => console.warn("drainQueueIfIdle (boot):", err));
    }, 2000);
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

function setStreaming(state) {
  isStreaming = state;
  // Send button stays available regardless of streaming state. Stop is a
  // separate button shown only while AI is actively responding.
  els.actionBtn.classList.add("send-btn");
  els.actionBtn.classList.remove("stop-btn");
  els.actionBtn.textContent = "▶";
  els.actionBtn.setAttribute("aria-label", "送出");
  if (els.stopBtn) els.stopBtn.hidden = !state;
  if (state) startStreamingPoll();
  else stopStreamingPoll();
}

function startStreamingPoll() {
  if (streamingPollTimer) return;
  streamingPollTimer = setInterval(() => {
    pollStreamingState().catch((err) => console.warn("pollStreamingState failed", err));
  }, STREAMING_POLL_INTERVAL_MS);
}

function stopStreamingPoll() {
  if (!streamingPollTimer) return;
  clearInterval(streamingPollTimer);
  streamingPollTimer = null;
}

async function pollStreamingState() {
  if (streamingPollInFlight) return;
  streamingPollInFlight = true;
  try {
    // SSE is best-effort in mobile/PWA browsers. Poll while busy so completed
    // gpt-5.5 replies still appear even if EventSource drops an update.
    await loadHistory();
    await refreshBusyStatus();
    await drainQueueIfIdle();
  } finally {
    streamingPollInFlight = false;
  }
}

async function refreshBusyStatus() {
  try {
    if (!currentDirectory) {
      const session = await api(`/session/${sessionID}`);
      currentDirectory = session?.directory ?? "";
    }
    if (!currentDirectory) return;
    const directory = currentDirectory.replace(/\\/g, "/");
    const statuses = await api(`/session/status?directory=${encodeURIComponent(directory)}`);
    const busy = statuses?.[sessionID]?.type === "busy";
    setStreaming(busy);
  } catch (err) {
    console.warn("refreshBusyStatus failed", err);
  }
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
  // First text delta — drop the thinking indicator if it was shown.
  body.querySelector(".thinking-indicator")?.remove();
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
      else if (statusType === "idle") {
        setStreaming(false);
        drainQueueIfIdle().catch((err) => console.warn("drainQueueIfIdle:", err));
      }
      break;
    }

    case "session.idle":
      // Definitive "all streaming done" signal. Do a final refresh of any
      // message we have buffered but haven't flushed yet, then drain any
      // queued user prompts.
      setStreaming(false);
      _deltaBuffers.clear();
      drainQueueIfIdle().catch((err) => console.warn("drainQueueIfIdle:", err));
      break;

    case "session.updated":
      refreshHeader();
      break;

    case "permission.asked":
      // Auto-accept every permission ask. Trust mode covers most patterns via
      // session.permission PATCH, but anything that slips through (new MCP
      // tools, unmapped patterns) would otherwise block the agent forever.
      // The user has opted into "always allow" for the compact UI; if they
      // ever want manual control, they can use the native SPA.
      autoAcceptPermission(props);
      break;

    case "permission.replied":
      // Server confirmation our auto-reply was received. No UI update needed.
      break;

    case "question.asked":
      renderQuestionRequest(props);
      maybeScrollOrShowChip();
      break;

    case "question.replied":
    case "question.rejected":
      markQuestionFinished(type, props);
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

// ─── Permission auto-accept (always-on) ────────────────────
// Schema (from opencode/src/permission/index.ts):
//   request:  { id, sessionID, permission, patterns[], metadata, always[], tool? }
//   reply:    POST /permission/:id/reply  body { reply: "once"|"always"|"reject" }
// We reply "always" so the same pattern stops asking for the rest of the
// session (server appends to session.permission, last-wins).

function autoAcceptPermission(req) {
  const id = req?.id;
  if (!id || _autoAcceptedPermissions.has(id)) return;
  _autoAcceptedPermissions.add(id);
  api(`/permission/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reply: "always" }),
  }).catch((err) => {
    // Remove from cache so a future retry can attempt again.
    _autoAcceptedPermissions.delete(id);
    console.warn("[compact] auto-accept permission failed", id, err);
  });
}

// ─── Question UI ───────────────────────────────────────────
// Schema (from opencode/src/question/index.ts):
//   request:  { id, sessionID, questions: [{ question, header, options:[{label,description}], multiple?, custom? }], tool? }
//   reply:    POST /question/:id/reply   body { answers: string[][] }  (per-question array of selected labels)
//   reject:   POST /question/:id/reject  body {}
// questionNodes and _autoAcceptedPermissions are declared near messageNodes (top of file)
// so loadHistory()'s .clear() call is unambiguous regardless of evaluation order.

function renderQuestionRequest(req) {
  const id = req?.id;
  const questions = Array.isArray(req?.questions) ? req.questions : [];
  if (!id || questions.length === 0) return;

  // If a card already exists (re-broadcast / reconnect), refresh it in place.
  let card = questionNodes.get(id);
  if (card) {
    card.querySelector(".qcard-status")?.replaceChildren();
    card.classList.remove("answered", "rejected");
  } else {
    card = document.createElement("div");
    card.className = "qcard";
    card.dataset.questionId = id;
    els.messages.appendChild(card);
    questionNodes.set(id, card);
  }

  // Per-question selection state. For single-select we submit on first click;
  // for multi-select we accumulate then submit via the footer button.
  const selections = questions.map(() => new Set());

  card.innerHTML = "";
  const head = document.createElement("div");
  head.className = "qcard-head";
  head.textContent = "AI 正在問你問題";
  card.appendChild(head);

  questions.forEach((q, qi) => {
    const block = document.createElement("div");
    block.className = "qblock";
    if (q.header) {
      const hdr = document.createElement("div");
      hdr.className = "qblock-header";
      hdr.textContent = q.header;
      block.appendChild(hdr);
    }
    if (q.question) {
      const txt = document.createElement("div");
      txt.className = "qblock-text";
      txt.innerHTML = renderMarkdown(q.question);
      block.appendChild(txt);
    }
    const opts = document.createElement("div");
    opts.className = "qopts" + (q.multiple ? " multi" : "");
    for (const opt of q.options ?? []) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "qopt";
      const labelText = String(opt.label ?? "");
      btn.dataset.label = labelText;
      btn.innerHTML = `<span class="qopt-label">${escapeHTML(labelText)}</span>` +
        (opt.description ? `<span class="qopt-desc">${escapeHTML(String(opt.description))}</span>` : "");
      btn.addEventListener("click", () => {
        if (q.multiple) {
          if (selections[qi].has(labelText)) {
            selections[qi].delete(labelText);
            btn.classList.remove("selected");
          } else {
            selections[qi].add(labelText);
            btn.classList.add("selected");
          }
        } else {
          // Single-select: clear siblings, mark this, submit if all sub-questions done.
          opts.querySelectorAll(".qopt.selected").forEach((el) => el.classList.remove("selected"));
          btn.classList.add("selected");
          selections[qi] = new Set([labelText]);
          maybeSubmitQuestion(id, questions, selections, card);
        }
      });
      opts.appendChild(btn);
    }
    block.appendChild(opts);
    card.appendChild(block);
  });

  // Footer: submit (multi) + skip
  const hasMulti = questions.some((q) => q.multiple);
  const footer = document.createElement("div");
  footer.className = "qcard-foot";
  if (hasMulti) {
    const submitBtn = document.createElement("button");
    submitBtn.type = "button";
    submitBtn.className = "qcard-submit";
    submitBtn.textContent = "送出";
    submitBtn.addEventListener("click", () => submitQuestion(id, selections, card));
    footer.appendChild(submitBtn);
  }
  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "qcard-skip";
  skipBtn.textContent = "略過";
  skipBtn.addEventListener("click", () => rejectQuestion(id, card));
  footer.appendChild(skipBtn);

  const status = document.createElement("div");
  status.className = "qcard-status";
  footer.appendChild(status);
  card.appendChild(footer);
}

function maybeSubmitQuestion(id, questions, selections, card) {
  // For single-select we submit only when every sub-question has an answer.
  // For multi-select we let the user hit "送出".
  const ready = questions.every((q, i) => q.multiple || selections[i].size > 0);
  if (ready && !questions.some((q) => q.multiple)) {
    submitQuestion(id, selections, card);
  }
}

async function submitQuestion(id, selections, card) {
  const answers = selections.map((s) => Array.from(s));
  card.classList.add("submitting");
  try {
    await api(`/question/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    // The server will emit question.replied via SSE — that handler marks the card.
  } catch (err) {
    card.classList.remove("submitting");
    showToast("送出回答失敗：" + err.message, "error");
  }
}

async function rejectQuestion(id, card) {
  card.classList.add("submitting");
  try {
    await api(`/question/${encodeURIComponent(id)}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (err) {
    card.classList.remove("submitting");
    showToast("略過失敗：" + err.message, "error");
  }
}

function markQuestionFinished(type, props) {
  const id = props?.requestID ?? props?.id;
  if (!id) return;
  const card = questionNodes.get(id);
  if (!card) return;
  card.classList.remove("submitting");
  card.classList.add(type === "question.rejected" ? "rejected" : "answered");
  // Disable further clicks.
  card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
  const status = card.querySelector(".qcard-status");
  if (status) {
    if (type === "question.rejected") {
      status.textContent = "(已略過)";
    } else {
      const answersArr = Array.isArray(props?.answers) ? props.answers : [];
      const flat = answersArr.flat().filter(Boolean);
      status.textContent = flat.length ? `已回答：${flat.join("、")}` : "已回答";
    }
  }
}

function normalizePendingList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.value)) return value.value;
  if (Array.isArray(value?.data)) return value.data;
  return value ? [value] : [];
}

function schedulePendingQuestionDrain() {
  if (pendingQuestionDrainTimer) return;
  pendingQuestionDrainTimer = setTimeout(() => {
    pendingQuestionDrainTimer = null;
    drainPendingInteractive().catch((err) => console.warn("drainPendingInteractive (question tool):", err));
  }, 250);
}

// ─── Prompt queue (persists across reloads) ────────────────
// Stored under localStorage["compact-queue:<sessionID>"]:
//   [{ id, text, attachments, model, queuedAt }, ...]
// Only prompts that were not handed to OpenCode yet live here. Compact now
// matches the native web UI: submit immediately to /prompt_async and let the
// OpenCode server queue prompts when the session is busy.
// (QUEUE_KEY, queue, and queueNodes are hoisted to the top of the file.)
const QUEUE_DRAIN_CHECK_DELAYS_MS = [1_500, 6_000, 15_000];
const queueDrainCheckTimers = new Set();

function persistQueue() {
  if (queue.length === 0) localStorage.removeItem(QUEUE_KEY);
  else localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

function enqueueMessage(text, attachments) {
  const model = compactPromptModel(currentModel);
  const item = {
    id: `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    text: text || "",
    attachments: attachments ?? [],
    model: model ? { ...model } : null,
    queuedAt: Date.now(),
  };
  queue.push(item);
  persistQueue();
  renderQueueItem(item);
  showToast(`已排入佇列 (${queue.length})`);
  startStreamingPoll();
  scheduleQueueDrainChecks();
}

function scheduleQueueDrainChecks() {
  for (const delay of QUEUE_DRAIN_CHECK_DELAYS_MS) {
    const timer = setTimeout(() => {
      queueDrainCheckTimers.delete(timer);
      refreshBusyStatus()
        .then(() => drainQueueIfIdle())
        .catch((err) => console.warn("queue drain check failed", err));
    }, delay);
    queueDrainCheckTimers.add(timer);
  }
}

function renderQueueItem(item) {
  if (queueNodes.has(item.id)) return;
  const node = document.createElement("div");
  node.className = "msg queued";
  node.dataset.queueId = item.id;

  const head = document.createElement("div");
  head.className = "msg-head";
  head.innerHTML =
    `<span class="msg-role user">Kevin</span>` +
    `<span class="msg-time">⏳ 已排入佇列</span>` +
    `<button class="queue-remove" type="button" aria-label="移除">×</button>`;
  const body = document.createElement("div");
  body.className = "msg-body";
  if (item.text) {
    const md = document.createElement("div");
    md.innerHTML = renderMarkdown(item.text);
    body.appendChild(md);
  }
  for (const a of item.attachments ?? []) {
    const img = document.createElement("img");
    img.src = a.dataUrl;
    img.alt = a.name ?? "";
    img.style.maxWidth = "240px";
    img.style.maxHeight = "240px";
    img.style.borderRadius = "8px";
    img.style.margin = "6px 0";
    img.style.display = "block";
    body.appendChild(img);
  }
  node.append(head, body);
  els.messages.appendChild(node);
  queueNodes.set(item.id, node);
  scrollToBottom();

  node.querySelector(".queue-remove").addEventListener("click", () => removeQueueItem(item.id));
}

function removeQueueItem(id) {
  queue = queue.filter((q) => q.id !== id);
  persistQueue();
  const node = queueNodes.get(id);
  if (node) { node.remove(); queueNodes.delete(id); }
}

let _draining = false;
async function drainQueueIfIdle() {
  if (_draining) return;
  if (queue.length === 0) return;
  _draining = true;
  try {
    const item = queue[0];
    // Optimistically remove from queue + DOM. sendNow() inserts its own
    // optimistic placeholder; the canonical message.updated SSE event
    // replaces it once OpenCode persists the new user message.
    queue = queue.slice(1);
    persistQueue();
    const node = queueNodes.get(item.id);
    if (node) { node.remove(); queueNodes.delete(item.id); }
    const ok = await sendNow(item.text, item.attachments, item.model);
    if (!ok) {
      // Send failed — put it back at the head so the next idle event tries again.
      queue.unshift(item);
      persistQueue();
      renderQueueItem(item);
    } else if (queue.length > 0) {
      setTimeout(() => drainQueueIfIdle().catch((err) => console.warn("drainQueueIfIdle:", err)), 0);
    }
  } finally {
    _draining = false;
  }
}

// ─── Optimistic user message ───────────────────────────────
// prompt_async returns 204 in ~300ms but the user message info event still
// has to round-trip through SSE. Render an optimistic placeholder so the
// user sees their text in the chat the instant they hit send.
function renderOptimisticUserMessage(text, attachments) {
  const node = document.createElement("div");
  node.className = "msg";
  node.dataset.optimistic = "true";
  const head = document.createElement("div");
  head.className = "msg-head";
  head.innerHTML = `<span class="msg-role user">Kevin</span><span class="msg-time">· ${fmtTime(Date.now())}</span>`;
  const body = document.createElement("div");
  body.className = "msg-body";
  if (text) {
    const md = document.createElement("div");
    md.innerHTML = renderMarkdown(text);
    body.appendChild(md);
  }
  for (const a of attachments ?? []) {
    const img = document.createElement("img");
    img.src = a.dataUrl;
    img.alt = a.name ?? "";
    img.style.maxWidth = "240px";
    img.style.maxHeight = "240px";
    img.style.borderRadius = "8px";
    img.style.margin = "6px 0";
    img.style.display = "block";
    body.appendChild(img);
  }
  node.append(head, body);
  els.messages.appendChild(node);
  scrollToBottom();
}

function removeOptimisticUserMessages() {
  els.messages.querySelectorAll('[data-optimistic="true"]').forEach((n) => n.remove());
}

async function drainPendingInteractive() {
  // Fire both in parallel; either failing should not block the other.
  const [perms, questions] = await Promise.all([
    api("/permission").catch(() => []),
    api("/question").catch(() => []),
  ]);
  for (const p of normalizePendingList(perms)) {
    if (p?.sessionID && p.sessionID !== sessionID) continue;
    autoAcceptPermission(p);
  }
  let renderedQuestion = false;
  for (const q of normalizePendingList(questions)) {
    if (q?.sessionID && q.sessionID !== sessionID) continue;
    renderQuestionRequest(q);
    renderedQuestion = true;
  }
  if (renderedQuestion) maybeScrollOrShowChip();
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
    setTimeout(() => {
      refreshBusyStatus()
        .then(() => loadHistory())
        .then(() => drainQueueIfIdle())
        .catch(() => {});
    }, 1500);
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

// ─── Session meta (title + rename) ─────────────────────────
const titleEls = {
  btn: document.getElementById("titleBtn"),
  text: document.getElementById("titleText"),
  input: document.getElementById("titleInput"),
  fs: document.getElementById("fsBtn"),
};

let currentTitle = "";

async function loadSessionMeta() {
  try {
    const s = await api(`/session/${sessionID}`);
    currentDirectory = s?.directory ?? currentDirectory;
    setTitle(s.title ?? "");
  } catch (err) {
    console.warn("loadSessionMeta failed", err);
  }
}

function setTitle(title) {
  currentTitle = title;
  titleEls.text.textContent = title || "(no title)";
  document.title = title ? `${title} · OpenCode` : "OpenCode";
}

function beginEditTitle() {
  titleEls.input.value = currentTitle;
  titleEls.btn.hidden = true;
  titleEls.input.hidden = false;
  titleEls.input.focus();
  titleEls.input.select();
}

function cancelEditTitle() {
  titleEls.input.hidden = true;
  titleEls.btn.hidden = false;
}

async function commitEditTitle() {
  const newTitle = titleEls.input.value.trim();
  if (!newTitle || newTitle === currentTitle) {
    cancelEditTitle();
    return;
  }
  const prevTitle = currentTitle;
  setTitle(newTitle);
  cancelEditTitle();
  try {
    await api(`/session/${sessionID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: newTitle }),
    });
  } catch (err) {
    showToast("改名失敗：" + err.message, "error");
    setTitle(prevTitle);
  }
}

titleEls.btn.addEventListener("click", beginEditTitle);
titleEls.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitEditTitle(); }
  else if (e.key === "Escape") { e.preventDefault(); cancelEditTitle(); }
});
titleEls.input.addEventListener("blur", commitEditTitle);

// ─── Fullscreen toggle ─────────────────────────────────────
// iOS Safari does NOT support Element.requestFullscreen on arbitrary
// elements (only <video>). Hide the button entirely on iOS — users
// should "Add to Home Screen" for a chrome-less PWA experience.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const fsSupported = !isIOS && (
  document.documentElement.requestFullscreen ||
  document.documentElement.webkitRequestFullscreen ||
  document.documentElement.mozRequestFullScreen
);

if (!fsSupported) {
  titleEls.fs.hidden = true;
} else {
  function refreshFullscreenButton() {
    titleEls.fs.classList.toggle("active", !!document.fullscreenElement);
  }
  titleEls.fs.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (err) {
      showToast("全螢幕失敗：" + err.message, "error");
    }
  });
  document.addEventListener("fullscreenchange", refreshFullscreenButton);
  refreshFullscreenButton();
}

// ─── Header refresh ────────────────────────────────────────
async function refreshHeader() {
  await Promise.all([
    loadSessionMeta(),
    loadModelForHeader(),
  ]);
}

// ─── Textarea: auto-grow + Enter submits, Shift+Enter newline ─
function resizeCompose() {
  els.compose.style.height = "auto";
  els.compose.style.height = Math.min(els.compose.scrollHeight, 140) + "px";
}
let isComposingInput = false;
let lastCompositionEndAt = 0;
let suppressNextEnterSubmit = false;
let suppressNextEnterTimer = null;

function markCompositionEnterSuppressed() {
  suppressNextEnterSubmit = true;
  clearTimeout(suppressNextEnterTimer);
  suppressNextEnterTimer = setTimeout(() => {
    suppressNextEnterSubmit = false;
  }, 1_000);
}

els.compose.addEventListener("input", resizeCompose);
els.compose.addEventListener("compositionstart", () => {
  isComposingInput = true;
  markCompositionEnterSuppressed();
});
els.compose.addEventListener("compositionend", () => {
  isComposingInput = false;
  lastCompositionEndAt = performance.now();
  markCompositionEnterSuppressed();
});
els.compose.addEventListener("beforeinput", (e) => {
  if (typeof e.inputType === "string" && e.inputType.toLowerCase().includes("composition")) {
    markCompositionEnterSuppressed();
  }
});
els.compose.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey) return;

  // macOS/iOS CJK IMEs use Enter to confirm candidates. During that flow some
  // browsers report `isComposing`, others only expose the legacy keyCode 229,
  // and Safari can dispatch Enter after compositionend. Suppress the next Enter
  // submit so the IME owns candidate confirmation; a second Enter sends.
  if (isComposingInput || e.isComposing || e.keyCode === 229 || suppressNextEnterSubmit || performance.now() - lastCompositionEndAt < 500) return;

  e.preventDefault();
  els.actionBtn.click();
});
els.compose.addEventListener("keyup", (e) => {
  if (e.key !== "Enter") return;
  suppressNextEnterSubmit = false;
  lastCompositionEndAt = 0;
  clearTimeout(suppressNextEnterTimer);
});

// ─── Send ──────────────────────────────────────────────────
let currentModel = { ...COMPACT_DEFAULT_MODEL };     // { providerID, modelID, variant }

// Fire-and-forget endpoint:
//   POST /session/:id/prompt_async returns 204 in ~300ms.
//   The agent runs in the background; SSE delivers the response.
//   We confirmed via probe that POST /message blocks for seconds and
//   POST /message with noReply:true skips the reply, so /prompt_async
//   is the only correct path here.
async function sendMessage() {
  const text = els.compose.value.trim();
  const attachments = pendingAttachments.slice();
  if (!text && attachments.length === 0) return;

  await sendNow(text, attachments, currentModel);
}

async function sendNow(text, attachments, model) {
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const a of attachments) {
    parts.push({ type: "file", mime: a.mime, url: a.dataUrl, filename: a.name });
  }
  const payload = { parts };
  const promptModel = compactPromptModel(model);
  if (promptModel) {
    payload.model = { providerID: promptModel.providerID, modelID: promptModel.modelID };
    if (promptModel.variant) payload.variant = promptModel.variant;
  }

  // Optimistic UI: render the user's message immediately, clear input,
  // show streaming state. SSE will deliver the canonical message.updated
  // shortly; renderMessage() removes the placeholder when the real one
  // for role=user arrives.
  renderOptimisticUserMessage(text, attachments);
  els.compose.value = "";
  resizeCompose();
  clearAttachments();
  setStreaming(true);

  const t0 = performance.now();
  try {
    await api(`/session/${sessionID}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const elapsed = performance.now() - t0;
    console.info(`[compact] POST /prompt_async returned in ${Math.round(elapsed)}ms`);
    return true;
  } catch (err) {
    setStreaming(false);
    // Drop the optimistic placeholder so the user does not see a "sent"
    // message that never actually went through.
    removeOptimisticUserMessages();
    showToast("送出失敗：" + err.message, "error");
    return false;
  }
}

els.actionBtn.addEventListener("click", () => {
  sendMessage();
});

if (els.stopBtn) {
  els.stopBtn.addEventListener("click", () => abortMessage());
}

// ─── Attachments ───────────────────────────────────────────
let pendingAttachments = [];
let attachmentGeneration = 0;
const MAX_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024;     // reject only truly huge originals
const MAX_ATTACHMENT_BYTES = 2.5 * 1024 * 1024;      // compressed payload target
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;            // queued data URL budget
const MAX_IMAGE_EDGE = 1800;
const IMAGE_QUALITIES = [0.82, 0.72, 0.62, 0.52];

els.attachBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", (e) => {
  const files = Array.from(e.target.files ?? []);
  e.target.value = "";  // allow same file twice
  for (const f of files) addAttachment(f);
});

async function addAttachment(file) {
  if (!file.type.startsWith("image/")) {
    showToast("僅支援圖片：" + file.name, "error");
    return;
  }
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    showToast(`圖片太大（>50MB）：${file.name}`, "error");
    return;
  }
  const generation = attachmentGeneration;
  try {
    const attachment = await prepareImageAttachment(file);
    if (generation !== attachmentGeneration) return;
    const totalAfter = pendingAttachments.reduce((s, a) => s + a.size, 0) + attachment.size;
    if (totalAfter > MAX_TOTAL_BYTES) {
      showToast("附件總量超過 20MB", "error");
      return;
    }
    pendingAttachments.push(attachment);
    renderAttachments();
  } catch (err) {
    if (generation !== attachmentGeneration) return;
    showToast("圖片壓縮失敗：" + (err instanceof Error ? err.message : file.name), "error");
  }
}

async function prepareImageAttachment(file) {
  let best = null;

  const bitmap = await loadImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(file.name);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  for (const quality of IMAGE_QUALITIES) {
    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    const dataUrl = await readBlobAsDataURL(blob);
    best = {
      blob,
      dataUrl,
      mime: "image/jpeg",
      name: file.name.replace(/\.[^.]+$/, "") + ".jpg",
    };
    if (blob.size <= MAX_ATTACHMENT_BYTES) break;
  }

  if (!best) throw new Error(file.name);

  if (file.size <= MAX_ATTACHMENT_BYTES && file.size <= best.blob.size) {
    const original = await readBlobAsDataURL(file);
    best = { blob: file, dataUrl: original, mime: file.type, name: file.name };
  }

  if (best.blob.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`壓縮後仍超過 ${formatBytes(MAX_ATTACHMENT_BYTES)}：${file.name}`);
  }

  return {
    name: best.name,
    mime: best.mime,
    size: best.blob.size,
    originalSize: file.size,
    dataUrl: best.dataUrl,
  };
}

function loadImageBitmap(file) {
  if ("createImageBitmap" in window) return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(file.name));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob failed"));
    }, mime, quality);
  });
}

function readBlobAsDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

function formatBytes(bytes) {
  return `${Math.round(bytes / 1024 / 102.4) / 10}MB`;
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
  attachmentGeneration += 1;
  pendingAttachments = [];
  els.fileInput.value = "";
  renderAttachments();
}

async function abortMessage() {
  try {
    await api(`/session/${sessionID}/abort`, { method: "POST" });
    setStreaming(false);
  } catch (err) {
    showToast("中止失敗：" + err.message, "error");
  }
}

// ─── Model picker ──────────────────────────────────────────
let providersCache = null;
let authedProviderIds = null;
let defaultModelFromConfig = null;

async function loadProviders() {
  if (providersCache) return providersCache;
  const [provResp, authResp] = await Promise.all([
    api("/provider"),
    api("/provider/auth").catch(() => ({})),
  ]);
  authedProviderIds = new Set(Object.keys(authResp ?? {}));
  // OpenCode /provider returns { all: [...] }
  const all = Array.isArray(provResp?.all) ? provResp.all : (Array.isArray(provResp) ? provResp : []);
  // Keep only providers the user has authed AND that have at least one active model.
  providersCache = all
    .filter((p) => authedProviderIds.has(p.id))
    .map((p) => ({
      id: p.id,
      name: p.name ?? p.id,
      models: Object.values(p.models ?? {})
        .filter((m) => m.status === "active"),
    }))
    .filter((p) => p.models.length > 0);
  return providersCache;
}

async function loadDefaultModelFromConfig() {
  if (defaultModelFromConfig !== null) return defaultModelFromConfig;
  try {
    const config = await api("/config");
    if (typeof config?.model === "string" && config.model.includes("/")) {
      const sep = config.model.indexOf("/");
      defaultModelFromConfig = compactPromptModel({
        providerID: config.model.slice(0, sep),
        modelID: config.model.slice(sep + 1),
      });
    } else {
      defaultModelFromConfig = false;
    }
  } catch {
    defaultModelFromConfig = false;
  }
  return defaultModelFromConfig;
}

async function loadModelForHeader() {
  try {
    setCurrentModel(currentModel ?? COMPACT_DEFAULT_MODEL);
  } catch (err) {
    console.error("loadModelForHeader failed", err);
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
    const group = document.createElement("div");
    group.className = "provider-group";
    const name = document.createElement("h3");
    name.className = "provider-name";
    name.textContent = provider.name;
    group.appendChild(name);
    for (const m of provider.models) {
      const row = document.createElement("div");
      row.className = "model-row";
      // Build variant pills, hiding the "none" variant pill (we render it as the
      // model row's single-button fallback instead). If a model has NO variants
      // at all, render a single "—" button to allow selecting it.
      const allVariants = m.variants ? Object.keys(m.variants) : [];
      const variantsExcludingNone = allVariants.filter((v) => v !== "none");
      const isCurrent = currentModel && currentModel.providerID === provider.id && currentModel.modelID === m.id;
      let pills;
      if (variantsExcludingNone.length > 0) {
        pills = variantsExcludingNone.map((v) => {
          const active = isCurrent && currentModel.variant === v;
          return `<span class="variant-pill${active ? " active" : ""}" data-provider="${escapeHTML(provider.id)}" data-model="${escapeHTML(m.id)}" data-variant="${escapeHTML(v)}">${escapeHTML(v)}</span>`;
        }).join("");
        // If "none" is also a valid variant (model supports running without
        // reasoning), add a no-variant pill too.
        if (allVariants.includes("none")) {
          const active = isCurrent && (currentModel.variant === "none" || !currentModel.variant);
          pills = `<span class="variant-pill${active ? " active" : ""}" data-provider="${escapeHTML(provider.id)}" data-model="${escapeHTML(m.id)}" data-variant="">—</span>` + pills;
        }
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
    setCurrentModel({
      providerID: pill.dataset.provider,
      modelID: pill.dataset.model,
      variant: pill.dataset.variant || null,
    });
    closePicker();
  });
}

// ── Trust mode ──────────────────────────────────────────────────────────────
// OpenCode v1.14.30's PATCH /session/:id appends permission rules (it does not
// replace). Rules are evaluated in order; the LAST matching rule wins.
//
// Trust ON  → append TRUST_PERMISSION_ARRAY (markers: bash * allow, edit * allow).
// Trust OFF → append TRUST_OFF_ARRAY (markers: bash * ask, edit * ask) to override.
//
// refreshTrustToggle checks the LAST bash-* or edit-* wildcard rule to determine
// the effective state.
//
// The allow / deny patterns below mirror opencode.json. Keep them in sync if
// the deny set changes there.
const TRUST_PERMISSION_ARRAY = [
  // ── edit (most "ask" → "allow"; secrets stay "deny") ──
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "edit", pattern: ".env", action: "deny" },
  { permission: "edit", pattern: ".env.*", action: "deny" },
  { permission: "edit", pattern: "*service-account*.json", action: "deny" },
  { permission: "edit", pattern: "*credential*.json", action: "deny" },
  { permission: "edit", pattern: "secrets/**", action: "deny" },
  { permission: "edit", pattern: ".claude-memory/**", action: "deny" },
  { permission: "edit", pattern: "**/.env", action: "deny" },
  { permission: "edit", pattern: "**/.env.*", action: "deny" },
  { permission: "edit", pattern: "**/*service-account*.json", action: "deny" },
  { permission: "edit", pattern: "**/*credential*.json", action: "deny" },
  { permission: "edit", pattern: "**/secrets/**", action: "deny" },
  { permission: "edit", pattern: "**/.claude-memory/**", action: "deny" },
  // ── bash (most "ask" → "allow"; destructive stays "deny") ──
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "git reset --hard*", action: "deny" },
  { permission: "bash", pattern: "git push --force*", action: "deny" },
  { permission: "bash", pattern: "git clean*", action: "deny" },
  { permission: "bash", pattern: "Remove-Item *", action: "deny" },
  { permission: "bash", pattern: "del *", action: "deny" },
  { permission: "bash", pattern: "rmdir *", action: "deny" },
  { permission: "bash", pattern: "* > .env*", action: "deny" },
  // ── git_git_* (preserve deny; allow the rest) ──
  { permission: "git_git_reset", pattern: "*", action: "deny" },
  { permission: "git_git_clean", pattern: "*", action: "deny" },
  { permission: "git_git_clear_working_dir", pattern: "*", action: "deny" },
  { permission: "git_git_push", pattern: "*", action: "allow" },
  { permission: "git_git_commit", pattern: "*", action: "allow" },
  // ── MCP wildcards (allow all) ──
  { permission: "github_*", pattern: "*", action: "allow" },
  { permission: "filesystem_*", pattern: "*", action: "allow" },
  { permission: "fetch_*", pattern: "*", action: "allow" },
];

// OFF markers: appended after TRUST_PERMISSION_ARRAY to override the allow
// wildcards. Last-wins evaluation means these take effect immediately.
const TRUST_OFF_ARRAY = [
  { permission: "bash", pattern: "*", action: "ask" },
  { permission: "edit", pattern: "*", action: "ask" },
];

async function setTrustMode(on) {
  // PATCH is append-only in OpenCode v1.14.30 — not replace. Sending the full
  // ON array or the OFF override array both accumulate, but since rules are
  // evaluated last-wins the most-recently appended wildcard wins.
  const payload = { permission: on ? TRUST_PERMISSION_ARRAY : TRUST_OFF_ARRAY };
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
    const perms = Array.isArray(session.permission) ? session.permission : [];
    // Find the last entry for the bash or edit wildcard ("*") — that is the
    // effective state since PATCH appends and last-wins evaluation applies.
    let on = false;
    for (const p of perms) {
      if (
        (p.permission === "edit" || p.permission === "bash") &&
        p.pattern === "*"
      ) {
        on = p.action === "allow";
      }
    }
    const toggle = document.getElementById("trustToggle");
    if (toggle) toggle.classList.toggle("off", !on);
  } catch (err) {
    console.warn("refreshTrustToggle failed", err);
  }
}

async function toggleTrust(e) {
  const el = e.currentTarget;
  const willBeOn = el.classList.contains("off");
  el.classList.toggle("off", !willBeOn); // optimistic
  try {
    await setTrustMode(willBeOn);
  } catch {
    el.classList.toggle("off", willBeOn); // revert
  }
}

// ─── Header overflow menu (⋯) ──────────────────────────────
// Small dropdown anchored to the moreBtn. Actions: create new session,
// open the same session in the native SPA, delete session.
const moreBtn = document.getElementById("moreBtn");
let moreMenu = null;

function base64urlEncode(str) {
  // UTF-8 safe — directories may contain CJK or path separators.
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildMoreMenu() {
  const menu = document.createElement("div");
  menu.className = "header-menu";
  menu.hidden = true;
  menu.innerHTML = `
    <button type="button" data-action="pin" data-pinned="0">📌 釘選此 session</button>
    <button type="button" data-action="new">+ 新 session</button>
    <button type="button" data-action="native">在 OpenCode 原生介面打開</button>
    <button type="button" data-action="delete" class="danger">刪除此 session</button>
  `;
  document.body.appendChild(menu);
  menu.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const action = btn.dataset.action;
    closeMoreMenu();
    if (action === "pin") doTogglePin();
    else if (action === "new") doNewSession();
    else if (action === "native") doOpenNative();
    else if (action === "delete") doDeleteSession();
  });
  return menu;
}

async function refreshPinMenuLabel() {
  if (!moreMenu) return;
  const btn = moreMenu.querySelector('[data-action="pin"]');
  if (!btn) return;
  try {
    const pins = await api("/c/pins");
    const pinned = Array.isArray(pins) && pins.includes(sessionID);
    btn.dataset.pinned = pinned ? "1" : "0";
    btn.textContent = pinned ? "✕ 取消釘選此 session" : "📌 釘選此 session";
  } catch (err) {
    console.warn("refreshPinMenuLabel:", err);
  }
}

async function doTogglePin() {
  if (!moreMenu) return;
  const btn = moreMenu.querySelector('[data-action="pin"]');
  const wasPinned = btn?.dataset.pinned === "1";
  try {
    await api(`/c/pins/${encodeURIComponent(sessionID)}`, {
      method: wasPinned ? "DELETE" : "POST",
    });
    showToast(wasPinned ? "已取消釘選" : "已釘選");
  } catch (err) {
    showToast("釘選操作失敗：" + err.message, "error");
  }
}

function openMoreMenu() {
  if (!moreMenu) moreMenu = buildMoreMenu();
  const r = moreBtn.getBoundingClientRect();
  moreMenu.style.top = `${r.bottom + 4}px`;
  moreMenu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  moreMenu.hidden = false;
  // Fetch fresh pin state on every open so the label is correct even if
  // another device toggled it.
  refreshPinMenuLabel();
  // Defer adding outside-click listener so the current click that opened
  // the menu does not also close it.
  setTimeout(() => {
    document.addEventListener("click", outsideMoreClickHandler);
    document.addEventListener("keydown", escMoreHandler);
  }, 0);
}

function closeMoreMenu() {
  if (moreMenu) moreMenu.hidden = true;
  document.removeEventListener("click", outsideMoreClickHandler);
  document.removeEventListener("keydown", escMoreHandler);
}

function outsideMoreClickHandler(e) {
  if (!moreMenu) return;
  if (moreMenu.contains(e.target) || e.target === moreBtn) return;
  closeMoreMenu();
}

function escMoreHandler(e) {
  if (e.key === "Escape") closeMoreMenu();
}

if (moreBtn) {
  moreBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (moreMenu && !moreMenu.hidden) closeMoreMenu();
    else openMoreMenu();
  });
}

function doNewSession() {
  // POST /c/new-session handles session creation + trust ruleset + 303
  // redirect — use a form submission so the browser follows automatically.
  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/c/new-session";
  document.body.appendChild(form);
  form.submit();
}

async function doOpenNative() {
  try {
    const s = await api(`/session/${sessionID}`);
    const dir = s?.directory ?? "";
    if (!dir) {
      showToast("此 session 沒有 directory，無法開啟原生介面", "error");
      return;
    }
    const slug = base64urlEncode(dir);
    window.open(`/${slug}/session/${sessionID}`, "_blank");
  } catch (err) {
    showToast("無法取得 session 路徑：" + err.message, "error");
  }
}

async function doDeleteSession() {
  if (!window.confirm("確定要刪除這個 session？此動作無法復原。")) return;
  try {
    await api(`/session/${sessionID}`, { method: "DELETE" });
    window.location.href = "/remote-sessions";
  } catch (err) {
    showToast("刪除失敗：" + err.message, "error");
  }
}

// ─── Refresh on visibility return ──────────────────────────
// When the tab is backgrounded (phone locked, switched app) the SSE
// connection can silently stall without firing onerror. On return we
// force a history refetch and a fresh SSE connection so the user sees
// whatever happened while they were away.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  refreshBusyStatus()
    .then(() => loadHistory())
    .then(() => drainQueueIfIdle())
    .catch((err) => console.warn("focus reload failed", err));
  try { sse.close(); } catch { /* noop */ }
  sse = connectSSE();
  refreshHeader();
  drainPendingInteractive().catch((err) => console.warn("drainPendingInteractive (visibility):", err));
});
