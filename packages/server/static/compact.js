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
