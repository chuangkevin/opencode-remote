export function busySessionIds(statuses) {
  if (!statuses || typeof statuses !== "object" || Array.isArray(statuses)) return [];
  return Object.entries(statuses)
    .filter(([, status]) => status?.type === "busy")
    .map(([sessionID]) => sessionID);
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
      const url = `/session/status?directory=${encodeURIComponent(directory)}`;
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
  intervalMs = 5_000,
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

  documentTarget.addEventListener("visibilitychange", handleVisibilityChange);
  windowTarget.addEventListener("pagehide", handlePageHide);
  windowTarget.addEventListener("pageshow", handlePageShow);
  handleVisibilityChange();
}

if (typeof document !== "undefined") {
  const cards = [...document.querySelectorAll(".session[data-session-id][data-session-directory]")];
  const directories = [...new Set(cards.map((card) => card.dataset.sessionDirectory))];
  const poller = createStatusPoller({
    load: (signal) => loadSessionStatuses(directories, signal),
    apply: (statuses) => {
      const busy = new Set(busySessionIds(statuses));
      for (const card of cards) {
        const indicator = card.querySelector(".running-indicator");
        if (indicator) indicator.hidden = !busy.has(card.dataset.sessionId);
      }
    },
  });

  bindStatusPollerLifecycle(poller, document, window);
}
