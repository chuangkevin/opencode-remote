export const FONT_SCALE_STORAGE_KEY = "opencode-font-scale";

const scales = ["1", "1.15", "1.3"];
const labels = {
  "1": "小",
  "1.15": "中",
  "1.3": "大",
};

export function normalizeFontScale(value) {
  return scales.includes(value) ? value : null;
}

export function defaultFontScale({ window } = globalThis) {
  try {
    return window.matchMedia("(max-width: 767px)").matches ? "1.15" : "1";
  } catch {
    return "1";
  }
}

export function getFontScale({ window } = globalThis) {
  try {
    return normalizeFontScale(window.localStorage.getItem(FONT_SCALE_STORAGE_KEY)) ?? defaultFontScale({ window });
  } catch {
    return defaultFontScale({ window });
  }
}

function applyFontScale(value, { document } = globalThis) {
  document.documentElement.style.setProperty("--font-scale", value);
  for (const button of document.querySelectorAll("[data-font-scale]")) {
    const active = button.getAttribute("data-font-scale") === value;
    const label = labels[button.getAttribute("data-font-scale")] ?? "";
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.textContent = `${active ? "✓ " : ""}字級：${label}`;
  }
  for (const button of document.querySelectorAll("[data-font-scale-cycle]")) {
    button.textContent = "Aa";
    button.title = `字級：${labels[value]}`;
    button.setAttribute("aria-label", `字級：${labels[value]}，按下切換`);
    button.setAttribute("data-font-scale-current", value);
  }
}

export function setFontScale(value, env = globalThis) {
  const next = normalizeFontScale(value) ?? defaultFontScale(env);
  try {
    env.window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, next);
  } catch {
    // Keep the current page usable when storage is blocked or full.
  }
  applyFontScale(next, env);
  return next;
}

export function createFontScaleController({ window, document }) {
  const listeners = [];
  let scale = getFontScale({ window });

  function bind(target, event, listener) {
    target.addEventListener(event, listener);
    listeners.push(() => target.removeEventListener(event, listener));
  }

  function apply(value = scale) {
    scale = normalizeFontScale(value) ?? defaultFontScale({ window });
    applyFontScale(scale, { document });
  }

  function set(value) {
    scale = setFontScale(value, { window, document });
  }

  bind(window, "storage", (event) => {
    if (event.key !== null && event.key !== FONT_SCALE_STORAGE_KEY) return;
    apply(normalizeFontScale(event.newValue) ?? defaultFontScale({ window }));
  });

  for (const button of document.querySelectorAll("[data-font-scale]")) {
    bind(button, "click", () => set(button.getAttribute("data-font-scale")));
  }
  for (const button of document.querySelectorAll("[data-font-scale-cycle]")) {
    bind(button, "click", () => {
      const index = scales.indexOf(scale);
      set(scales[(index + 1) % scales.length]);
    });
  }

  apply();
  return {
    get scale() { return scale; },
    setFontScale: set,
    apply,
    dispose() {
      for (const remove of listeners.splice(0)) remove();
    },
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  createFontScaleController({ window, document });
}
