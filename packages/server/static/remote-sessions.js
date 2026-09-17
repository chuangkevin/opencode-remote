export function busySessionIds(statuses) {
  if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) return [];
  return Object.entries(statuses)
    .filter(([, status]) => status?.type === "busy")
    .map(([sessionID]) => sessionID);
}

export function findMissingBusySessions(statuses, cardIds) {
  const existing = new Set(Array.isArray(cardIds) ? cardIds : []);
  return busySessionIds(statuses).filter((id) => !existing.has(id));
}

export async function loadSessionStatuses(directories, signal, fetchFn = globalThis.fetch) {
  const uniqueDirectories = [...new Set(directories)];
  const statusMaps = new Array(uniqueDirectories.length);
  let nextIndex = 0;

  async function loadNext() {
    while (nextIndex < uniqueDirectories.length) {
      const index = nextIndex;
      nextIndex += 1;
      const directory = uniqueDirectories[index];
      const url = `/c/session-status?directory=${encodeURIComponent(directory)}`;
      const response = await fetchFn(url, { signal });
      if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
      const statuses = await response.json();
      if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) {
        throw new Error(`GET ${url} returned an invalid payload`);
      }
      statusMaps[index] = statuses;
    }
  }

  const workerResults = await Promise.allSettled(
    Array.from({ length: Math.min(4, uniqueDirectories.length) }, () => loadNext()),
  );
  const failedWorker = workerResults.find((result) => result.status === "rejected");
  if (failedWorker) throw failedWorker.reason;

  return Object.assign({}, ...statusMaps);
}

export function createStatusPoller({
  load,
  apply,
  intervalMs = 2_000,
  timeoutMs = 3_000,
  setIntervalFn = globalThis.setInterval.bind(globalThis),
  clearIntervalFn = globalThis.clearInterval.bind(globalThis),
  setTimeoutFn = globalThis.setTimeout.bind(globalThis),
  clearTimeoutFn = globalThis.clearTimeout.bind(globalThis),
}) {
  let inFlight = false;
  let intervalID;
  let activeController;
  let generation = 0;
  let stopped = false;

  async function poll() {
    if (inFlight || stopped) return false;
    inFlight = true;
    const pollGeneration = generation;
    const controller = new AbortController();
    activeController = controller;
    const timeoutID = setTimeoutFn(() => controller.abort(), timeoutMs);

    try {
      const statuses = await load(controller.signal);
      if (stopped || pollGeneration !== generation) return false;
      apply(statuses);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeoutFn(timeoutID);
      activeController = undefined;
      inFlight = false;
    }
  }

  function start() {
    if (intervalID !== undefined) return;
    stopped = false;
    generation += 1;
    void poll();
    intervalID = setIntervalFn(() => void poll(), intervalMs);
  }

  function stop() {
    stopped = true;
    generation += 1;
    if (intervalID !== undefined) clearIntervalFn(intervalID);
    intervalID = undefined;
    activeController?.abort();
  }

  return { poll, start, stop };
}

export function bindStatusPollerLifecycle(poller, documentTarget, windowTarget) {
  const handleVisibilityChange = () => {
    if (documentTarget.visibilityState === "hidden") poller.stop();
    else poller.start();
  };
  const handlePageHide = () => poller.stop();
  const handlePageShow = () => handleVisibilityChange();
  const handleFocus = () => handleVisibilityChange();

  documentTarget.addEventListener("visibilitychange", handleVisibilityChange);
  windowTarget.addEventListener("pagehide", handlePageHide);
  windowTarget.addEventListener("pageshow", handlePageShow);
  windowTarget.addEventListener("focus", handleFocus);
  handleVisibilityChange();
}

if (typeof document !== "undefined") {
  let cards = [...document.querySelectorAll(".session[data-session-id][data-session-directory]")];
  let directories = [...new Set(cards.map((card) => card.dataset.sessionDirectory))];
  let lastRefreshTime = 0;
  let isRefreshing = false;

  function currentSessionWindow() {
    const value = document.body?.dataset.window;
    return value === "30d" || value === "all" ? value : "3d";
  }

  function remoteSessionsUrl(windowKey = currentSessionWindow()) {
    return `/remote-sessions?window=${encodeURIComponent(windowKey)}`;
  }

  function refreshCards() {
    cards = [...document.querySelectorAll(".session[data-session-id][data-session-directory]")];
    directories = [...new Set(cards.map((card) => card.dataset.sessionDirectory))];
  }

  function applyRemoteSessionsHtml(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    const nextList = doc.querySelector("#sessionList");
    const currentList = document.querySelector("#sessionList");
    if (!nextList || !currentList) return false;

    currentList.innerHTML = nextList.innerHTML;
    const nextWindow = doc.body?.dataset.window;
    if (nextWindow === "3d" || nextWindow === "30d" || nextWindow === "all") {
      document.body.dataset.window = nextWindow;
    }

    const nextLabel = doc.querySelector(".window-label");
    const currentLabel = document.querySelector(".window-label");
    if (nextLabel && currentLabel) currentLabel.textContent = nextLabel.textContent;

    const nextButton = doc.querySelector(".load-more-btn");
    const currentButton = document.querySelector(".load-more-btn");
    if (currentButton) {
      if (nextButton) {
        currentButton.textContent = nextButton.textContent;
        currentButton.dataset.nextWindow = nextButton.dataset.nextWindow || "";
        currentButton.hidden = nextButton.hidden;
        currentButton.disabled = nextButton.disabled;
      } else {
        currentButton.hidden = true;
        currentButton.disabled = true;
        currentButton.dataset.nextWindow = "";
      }
    }

    refreshCards();
    return true;
  }

  function applyStatuses(statuses) {
    const busy = new Set(busySessionIds(statuses));
    for (const card of cards) {
      const indicator = card.querySelector(".running-indicator");
      if (indicator) indicator.hidden = !busy.has(card.dataset.sessionId);
    }
  }

  const poller = createStatusPoller({
    load: (signal) => loadSessionStatuses(directories, signal),
    apply: async (statuses) => {
      applyStatuses(statuses);
      const cardIds = cards.map((card) => card.dataset.sessionId).filter(Boolean);
      const missing = findMissingBusySessions(statuses, cardIds);
      const now = Date.now();
      if (missing.length > 0 && now - lastRefreshTime > 15_000) {
        if (isRefreshing) return;
        isRefreshing = true;
        try {
          const response = await fetch(remoteSessionsUrl());
          if (!response.ok) return;
          const html = await response.text();
          if (applyRemoteSessionsHtml(html)) {
            lastRefreshTime = Date.now();
            applyStatuses(statuses);
          }
        } catch {
          // 失敗就靜默略過，下一輪再試
        } finally {
          isRefreshing = false;
        }
      }
    },
  });

  document.addEventListener("click", async (event) => {
    const button = event.target.closest(".load-more-btn");
    if (!button) return;
    event.preventDefault();
    const nextWindow = button.dataset.nextWindow;
    if (nextWindow !== "30d" && nextWindow !== "all") return;

    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = "載入中…";
    try {
      const response = await fetch(remoteSessionsUrl(nextWindow));
      if (!response.ok) throw new Error(`GET ${remoteSessionsUrl(nextWindow)} returned ${response.status}`);
      const html = await response.text();
      if (!applyRemoteSessionsHtml(html)) throw new Error("session list not found");
      lastRefreshTime = Date.now();
    } catch (error) {
      button.disabled = false;
      button.textContent = previousText;
      console.error(error);
    }
  });

  bindStatusPollerLifecycle(poller, document, window);
}
