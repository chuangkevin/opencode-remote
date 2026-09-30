// /pairs page client: dashboard + list views over GET /api/pairs.
//
// Visibility rules live in ./pairs-rules.js (single source of truth, also
// used by the /remote-sessions 夥伴 badge). Re-exported here so existing
// imports from this module keep working.
// Only re-renders cards that changed; relative times tick locally every second.

export { DASHBOARD_ACTIVE_MS, DASHBOARD_IDLE_MS, PAIR_ARCHIVE_MS, archivedPair, dashboardVisible, visiblePairs } from "./pairs-rules.js";
import { visiblePairs } from "./pairs-rules.js";
export const PAIRS_VIEW_KEY = "pairs-view";
export const AGGREGATE_FETCH_TIMEOUT_MS = 1500;
export const AGGREGATE_OFFLINE_COOLDOWN_MS = 60 * 1000;

export function mergeAggregatePairs(remoteLists) {
  const byId = new Map();
  for (const list of remoteLists) {
    for (const pair of list) {
      const prev = byId.get(pair.id);
      if (!prev || (pair.lastActivityAt ?? 0) > (prev.lastActivityAt ?? 0)) byId.set(pair.id, pair);
    }
  }
  return [...byId.values()].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

export function remoteOfflineUntil(lastFailureAt, now = Date.now(), cooldown = AGGREGATE_OFFLINE_COOLDOWN_MS) {
  return lastFailureAt === undefined ? 0 : lastFailureAt + cooldown;
}

export function remoteIsOffline(lastFailureAt, now = Date.now(), cooldown = AGGREGATE_OFFLINE_COOLDOWN_MS) {
  return remoteOfflineUntil(lastFailureAt, now, cooldown) > now;
}

export function getBasePath(documentObject = globalThis.document) {
  const value = documentObject?.querySelector('meta[name="opencode-base"]')?.content || "";
  return /^\/(sara|l390|home)$/.test(value) ? value : "";
}

export function migrateRemoteUrl(url) {
  const normalized = String(url || "").trim().replace(/\/+$/, "");
  return ({
    "https://opencode-sara.sisihome.org": "https://opencode.sisihome.org/sara",
    "https://opencode-l390.sisihome.org": "https://opencode.sisihome.org/l390",
    "https://opencode-home.sisihome.org": "https://opencode.sisihome.org/home",
  })[normalized] || normalized;
}

export const PAIR_REMOTE_DOMAINS = Object.freeze({
  mac: "https://opencode-sara.sisihome.org",
  l390: "https://opencode-l390.sisihome.org",
  home: "https://opencode.sisihome.org",
});

export function formatRelative(ts, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 天前`;
}

export function statusLabel(status) {
  if (status === "busy") return "執行中";
  if (status === "ask") return "等你回答";
  if (status === "error") return "出錯";
  return "閒置";
}

export function partnerLabel(pair) {
  return pair && pair.partner === "pi" ? "Pi" : "OpenCode";
}

export function withBase(basePath, path) {
  return typeof path === "string" && path.startsWith("/") ? `${basePath}${path}` : path;
}

export function pairCardUrl(pair, aggregate, ownPath) {
  return aggregate && pair.hostUrl ? pair.hostUrl.replace(/\/+$/, "") + pair.url : ownPath(pair.url);
}

if (typeof document !== "undefined") {
  const BASE_PATH = getBasePath();
  const ownPath = (path) => withBase(BASE_PATH, path);
  const ownKey = (key) => `${key}${BASE_PATH ? `:${BASE_PATH.slice(1)}` : ""}`;
  const grid = document.getElementById("pairGrid");
  const viewButtons = [...document.querySelectorAll("[data-view-btn]")];
  const aggNote = document.getElementById("aggNote");
  const sessionsLink = document.querySelector('a.pairs-btn[href="/remote-sessions"]');
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── Aggregate mode: opencode.sisihome.org/pairs (or ?all=1) merges every
  // remote's /api/pairs. Remote list mirrors hub.html (opencode-hub:remotes).
  const AGG_DEFAULTS = [
    { id: "mac", name: "Mac", url: "https://opencode.sisihome.org/sara" },
    { id: "l390", name: "L390", url: "https://opencode.sisihome.org/l390" },
    { id: "home", name: "Home", url: "https://opencode.sisihome.org/home" },
  ];
  const queryAll = (() => { try { return new URLSearchParams(location.search).get("all") === "1"; } catch { return false; } })();
  const AGGREGATE = (!BASE_PATH && location.hostname === "opencode.sisihome.org") || queryAll;
  let remotes = AGG_DEFAULTS;
  if (AGGREGATE) {
    try {
      const stored = JSON.parse(localStorage.getItem(ownKey("opencode-hub:remotes")));
      if (Array.isArray(stored) && stored.length > 0) {
        remotes = stored
          .filter((r) => r && r.enabled !== false && typeof r.url === "string" && /^https?:\/\/.+/.test(r.url.trim()))
          .map((r) => ({ id: String(r.id ?? r.url), name: String(r.name ?? r.url), url: migrateRemoteUrl(r.url) }));
        if (remotes.length === 0) remotes = AGG_DEFAULTS;
      }
    } catch { /* keep defaults */ }
    document.body.dataset.agg = "1";
    if (sessionsLink) sessionsLink.setAttribute("href", "/");
  }

  function aggHostTag(url) {
    try {
      return String(new URL(url).hostname);
    } catch {
      return String(url);
    }
  }
  let view = "dashboard";
  try {
    const stored = localStorage.getItem(PAIRS_VIEW_KEY);
    if (stored === "list" || stored === "dashboard" || stored === "archived") view = stored;
  } catch { /* private mode: keep default */ }
  const archivedButton = document.createElement("button");
  archivedButton.type = "button";
  archivedButton.dataset.viewBtn = "archived";
  archivedButton.setAttribute("aria-pressed", "false");
  archivedButton.textContent = "已歸檔";
  viewButtons[viewButtons.length - 1]?.insertAdjacentElement("afterend", archivedButton);
  viewButtons.push(archivedButton);
  let pairsById = new Map();
  let lastRenderedSig = new Map();
  const remoteFailures = new Map();
  let aggregateGeneration = 0;

  function applyView() {
    document.body.dataset.view = view;
    for (const btn of viewButtons) {
      btn.setAttribute("aria-pressed", btn.dataset.viewBtn === view ? "true" : "false");
    }
    try {
    localStorage.setItem(ownKey(PAIRS_VIEW_KEY), view);
    } catch { /* ignore */ }
  }

  function cardSignature(pair) {
    return [pair.status, pair.lastActivityAt, pair.lastText, pair.contextPct, JSON.stringify(pair.model ?? null), pair.acceptedAt ?? ""].join("|");
  }

  function modelShortId(model) {
    if (!model || typeof model.id !== "string") return "";
    const parts = model.id.split("/");
    return parts[parts.length - 1];
  }

  function modelFullLabel(model) {
    if (!model || typeof model.id !== "string" || !model.id) return "";
    const variant = typeof model.variant === "string" && model.variant && model.variant !== "default"
      ? ` · ${model.variant}`
      : "";
    return `${model.id}${variant}`;
  }

  function contextBar(pair) {
    if (pair.contextPct === null || pair.contextPct === undefined) return "";
    const over = pair.contextPct > 50;
    return `<div class="ctxrow"><div class="ctxbar${over ? " over" : ""}" title="對話已用掉模型上限的 ${pair.contextPct}%"><i style="width:${Math.min(100, pair.contextPct)}%"></i><b></b></div>` +
      `<span class="ctxpct">context ${pair.contextPct}%</span></div>`;
  }

  function refreshModelLine(card, pair) {
    const modelEl = card.querySelector(".model-line");
    if (!modelEl) return;
    const label = modelFullLabel(pair.model);
    modelEl.textContent = "";
    const idSpan = document.createElement("span");
    idSpan.className = "model-id";
    idSpan.textContent = `模型：${label}`;
    modelEl.appendChild(idSpan);
    if (pair.model && pair.model.provider) {
      const provSpan = document.createElement("span");
      provSpan.className = "model-provider";
      provSpan.textContent = pair.model.provider;
      modelEl.appendChild(document.createTextNode(" "));
      modelEl.appendChild(provSpan);
    }
    card.title = label;
  }

  function renderCard(pair) {
    const a = document.createElement("a");
    a.className = "card";
    // Aggregate mode: absolute URL to the owning remote.
    a.href = pairCardUrl(pair, AGGREGATE, ownPath);
    a.dataset.sessionId = pair.id;
    const hostTag = AGGREGATE && pair.hostName ? `<span class="host-tag"></span>` : "";
    const hasModel = modelFullLabel(pair.model) !== "";
    const modelLine = hasModel ? `<div class="model-line"></div>` : "";
    a.innerHTML =
      `<div class="card-top card-row"><span class="dot ${pair.status}"></span>` +
      hostTag +
      `<span class="partner-tag partner-${pair.partner === "pi" ? "pi" : "opencode"}">${partnerLabel(pair)}</span>` +
      `<span class="owner"></span>` +
      `<span class="meta"><span data-rel="${pair.lastActivityAt}">${formatRelative(pair.lastActivityAt)}</span></span></div>` +
      `<div class="partner">夥伴：${partnerLabel(pair)}</div>` +
      modelLine +
      `<div class="task"></div>` +
      `<div class="meta"><span class="status-word">${statusLabel(pair.status)}</span><span class="ctxpct-inline"></span></div>` +
      contextBar(pair) +
      `<p class="lasttext"></p>`;
    const hostEl = a.querySelector(".host-tag");
    if (hostEl) hostEl.textContent = pair.hostName;
    a.querySelector(".owner").textContent = `派工：${pair.owner}`;
    const modelEl = a.querySelector(".model-line");
    if (modelEl) refreshModelLine(a, pair);
    a.querySelector(".task").textContent = pair.task;
    const inline = a.querySelector(".ctxpct-inline");
    if (inline && pair.contextPct !== null && pair.contextPct !== undefined) {
      inline.textContent = ` · context ${pair.contextPct}%`;
    }
    // 手機單行／列表檢視：task 後顯示模型最後一段，完整字串放 title。
    const short = modelShortId(pair.model);
    if (short) {
      const taskEl = a.querySelector(".task");
      const tag = document.createElement("span");
      tag.className = "model-short";
      tag.textContent = ` · ${short}`;
      taskEl.appendChild(tag);
      taskEl.title = modelFullLabel(pair.model);
    }
    a.querySelector(".lasttext").textContent = "";
    a._textTarget = "";
    return a;
  }

  function updateCardText(card, pair) {
    const el = card.querySelector(".lasttext");
    const target = pair.lastText ?? "";
    if (card._textTarget === target) return;
    const prev = card._textTarget ?? "";
    card._textTarget = target;
    if (reducedMotion || prev === "" || !target.startsWith(prev)) {
      el.textContent = target;
      return;
    }
    // Typewriter: reveal only the appended tail.
    let i = prev.length;
    const timer = setInterval(() => {
      i += 3;
      el.textContent = target.slice(0, i);
      if (i >= target.length) {
        clearInterval(timer);
        el.textContent = target;
      }
    }, 30);
  }

  function flashCard(card) {
    if (reducedMotion) return;
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 800);
  }

  function render(pairs) {
    const now = Date.now();
    const visible = visiblePairs(pairs, view, now);
    const seen = new Set();
    for (const pair of visible) {
      seen.add(pair.id);
      const sig = cardSignature(pair);
      let card = grid.querySelector(`[data-session-id="${CSS.escape(pair.id)}"]`);
      if (!card) {
        card = renderCard(pair);
        grid.appendChild(card);
        lastRenderedSig.set(pair.id, "");
      }
      if (lastRenderedSig.get(pair.id) !== sig) {
        const statusChanged = card.querySelector(".dot")?.className !== `dot ${pair.status}`;
        card.querySelector(".dot").className = `dot ${pair.status}`;
        card.querySelector(".owner").textContent = `派工：${pair.owner}`;
        card.querySelector(".task").textContent = pair.task;
        refreshModelLine(card, pair);
        card.querySelector("[data-rel]").textContent = formatRelative(pair.lastActivityAt, now);
        card.querySelector("[data-rel]").dataset.rel = String(pair.lastActivityAt);
        const hadText = (card._textTarget ?? "") !== "";
        const textChanged = card._textTarget !== pair.lastText;
        updateCardText(card, pair);
        if (hadText && textChanged) flashCard(card);
        void statusChanged;
        lastRenderedSig.set(pair.id, sig);
      }
    }
    for (const card of [...grid.querySelectorAll("[data-session-id]")]) {
      if (!seen.has(card.dataset.sessionId)) {
        card.remove();
        lastRenderedSig.delete(card.dataset.sessionId);
      }
    }
    if (visible.length === 0) {
      grid.innerHTML = `<div class="empty">目前沒有夥伴 session</div>`;
    } else {
      grid.querySelector(".empty")?.remove();
      // Keep DOM order = newest first.
      for (const pair of visible) {
        const card = grid.querySelector(`[data-session-id="${CSS.escape(pair.id)}"]`);
        if (card) grid.appendChild(card);
      }
    }
  }

  // Relative times tick locally every second (no API call).
  setInterval(() => {
    const now = Date.now();
    for (const el of grid.querySelectorAll("[data-rel]")) {
      el.textContent = formatRelative(Number(el.dataset.rel), now);
    }
  }, 1000);

  async function poll() {
    try {
      if (!AGGREGATE) {
        const res = view === "archived"
          ? await fetch(ownPath("/api/pairs?archived=1"), { cache: "no-store" })
          : await fetch(ownPath("/api/pairs"));
        if (!res.ok) return;
        const pairs = await res.json();
        if (!Array.isArray(pairs)) return;
        pairsById = new Map(pairs.map((p) => [p.id, p]));
        render(pairs);
        return;
      }
      // Aggregate: start all remotes together, but render each successful result
      // immediately instead of waiting for the slowest remote.
      const generation = ++aggregateGeneration;
      const remoteLists = new Map();
      const updateAggregate = () => {
        if (generation !== aggregateGeneration) return;
        const pairs = mergeAggregatePairs([...remoteLists.values()]);
        pairsById = new Map(pairs.map((p) => [`${p.hostUrl}${p.id}`, p]));
        const down = remotes.filter((r) => remoteIsOffline(remoteFailures.get(r.id))).map((r) => r.name);
        if (aggNote) {
          aggNote.hidden = down.length === 0;
          if (down.length > 0) aggNote.classList.add("show");
          else aggNote.classList.remove("show");
          aggNote.textContent = down.length > 0 ? `${down.join("、")} 連不上，只顯示其他台` : "";
        }
        renderAggregate(pairs);
      };
      await Promise.allSettled(remotes.map(async (r) => {
        if (remoteIsOffline(remoteFailures.get(r.id))) return;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), AGGREGATE_FETCH_TIMEOUT_MS);
        try {
          const query = view === "archived" ? "?archived=1" : "";
          const res = await fetch(r.url.replace(/\/+$/, "") + `/api/pairs${query}`, { cache: "no-store", signal: controller.signal });
          if (!res.ok) throw new Error(`GET ${r.url}/api/pairs returned ${res.status}`);
          const list = await res.json();
          if (!Array.isArray(list)) throw new Error("invalid pairs payload");
          remoteFailures.delete(r.id);
          remoteLists.set(r.id, list.map((p) => ({ ...p, hostName: r.name, hostUrl: r.url })));
        } catch {
          remoteFailures.set(r.id, Date.now());
        } finally {
          clearTimeout(timeout);
        }
        updateAggregate();
      }));
    } catch {
      // next tick retries
    }
  }

  function renderAggregate(pairs) {
    // Reuse render() by temporarily namespacing ids.
    const namespaced = pairs.map((p) => ({ ...p, id: `${p.hostUrl}${p.id}` }));
    const realIds = new Map(namespaced.map((n, i) => [n.id, pairs[i]]));
    const now = Date.now();
    const visible = visiblePairs(pairs, view, now);
    const seen = new Set();
    for (const pair of visible) {
      const nid = `${pair.hostUrl}${pair.id}`;
      seen.add(nid);
      const sig = cardSignature(pair);
      let card = grid.querySelector(`[data-session-id="${CSS.escape(nid)}"]`);
      if (!card) {
        card = renderCard({ ...pair, id: nid });
        const hostEl = card.querySelector(".host-tag");
        if (hostEl) hostEl.textContent = pair.hostName;
        grid.appendChild(card);
        lastRenderedSig.set(nid, "");
      }
      if (lastRenderedSig.get(nid) !== sig) {
        card.querySelector(".dot").className = `dot ${pair.status}`;
        card.querySelector(".owner").textContent = `派工：${pair.owner}`;
        refreshModelLine(card, pair);
        card.querySelector(".task").textContent = pair.task;
        card.querySelector("[data-rel]").textContent = formatRelative(pair.lastActivityAt, now);
        card.querySelector("[data-rel]").dataset.rel = String(pair.lastActivityAt);
        updateCardText(card, pair);
        lastRenderedSig.set(nid, sig);
      }
      void realIds;
    }
    for (const card of [...grid.querySelectorAll("[data-session-id]")]) {
      if (!seen.has(card.dataset.sessionId)) {
        card.remove();
        lastRenderedSig.delete(card.dataset.sessionId);
      }
    }
    if (visible.length === 0) {
      grid.innerHTML = `<div class="empty">目前沒有夥伴 session</div>`;
    } else {
      grid.querySelector(".empty")?.remove();
      for (const pair of visible) {
        const card = grid.querySelector(`[data-session-id="${CSS.escape(`${pair.hostUrl}${pair.id}`)}"]`);
        if (card) grid.appendChild(card);
      }
    }
  }

  for (const btn of viewButtons) {
    btn.addEventListener("click", () => {
      view = btn.dataset.viewBtn === "archived" ? "archived" : btn.dataset.viewBtn === "list" ? "list" : "dashboard";
      applyView();
      lastRenderedSig = new Map();
      grid.innerHTML = "";
      void poll();
    });
  }

  applyView();
  void poll();
  setInterval(poll, 3000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void poll();
  });
}
