// /pairs page client: dashboard + list views over GET /api/pairs.
//
// Dashboard shows pairs that still need attention (never accepted, or
// active within the last 30 minutes); the list shows everything newest first.
// Only re-renders cards that changed; relative times tick locally every second.

export const PAIRS_VIEW_KEY = "pairs-view";
export const DASHBOARD_ACTIVE_MS = 30 * 60 * 1000;

export function dashboardVisible(pair, now = Date.now()) {
  if (pair.acceptedAt === undefined || pair.acceptedAt === null) return true;
  return now - pair.lastActivityAt < DASHBOARD_ACTIVE_MS;
}

export function visiblePairs(pairs, view, now = Date.now()) {
  const sorted = [...pairs].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  if (view === "list") return sorted;
  return sorted.filter((p) => dashboardVisible(p, now));
}

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

if (typeof document !== "undefined") {
  const grid = document.getElementById("pairGrid");
  const viewButtons = [...document.querySelectorAll("[data-view-btn]")];
  const reducedMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  let view = "dashboard";
  try {
    const stored = localStorage.getItem(PAIRS_VIEW_KEY);
    if (stored === "list" || stored === "dashboard") view = stored;
  } catch { /* private mode: keep default */ }
  let pairsById = new Map();
  let lastRenderedSig = new Map();

  function applyView() {
    document.body.dataset.view = view;
    for (const btn of viewButtons) {
      btn.setAttribute("aria-pressed", btn.dataset.viewBtn === view ? "true" : "false");
    }
    try {
      localStorage.setItem(PAIRS_VIEW_KEY, view);
    } catch { /* ignore */ }
  }

  function cardSignature(pair) {
    return [pair.status, pair.lastActivityAt, pair.lastText, pair.contextPct, pair.acceptedAt ?? ""].join("|");
  }

  function renderCard(pair) {
    const a = document.createElement("a");
    a.className = "card";
    a.href = pair.url;
    a.dataset.sessionId = pair.id;
    const ctx = pair.contextPct === null || pair.contextPct === undefined
      ? ""
      : `<div class="ctxbar" title="context ${pair.contextPct}%"><i style="width:${Math.min(100, pair.contextPct)}%"></i></div>`;
    a.innerHTML =
      `<div class="card-top"><span class="dot ${pair.status}"></span>` +
      `<span class="owner"></span>` +
      `<span class="meta"><span data-rel="${pair.lastActivityAt}">${formatRelative(pair.lastActivityAt)}</span></span></div>` +
      `<div class="task"></div>` +
      `<div class="meta"><span>${statusLabel(pair.status)}</span></div>` +
      ctx +
      `<p class="lasttext"></p>`;
    a.querySelector(".owner").textContent = pair.owner;
    a.querySelector(".task").textContent = pair.task;
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
        card.querySelector(".owner").textContent = pair.owner;
        card.querySelector(".task").textContent = pair.task;
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
      const res = await fetch("/api/pairs");
      if (!res.ok) return;
      const pairs = await res.json();
      if (!Array.isArray(pairs)) return;
      pairsById = new Map(pairs.map((p) => [p.id, p]));
      render(pairs);
    } catch {
      // next tick retries
    }
  }

  for (const btn of viewButtons) {
    btn.addEventListener("click", () => {
      view = btn.dataset.viewBtn === "list" ? "list" : "dashboard";
      applyView();
      lastRenderedSig = new Map();
      grid.innerHTML = "";
      render([...pairsById.values()]);
    });
  }

  applyView();
  void poll();
  setInterval(poll, 3000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void poll();
  });
}
