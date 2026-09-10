export const THEME_STORAGE_KEY = "opencode-color-scheme";

const preferences = ["system", "light", "dark"];
const labels = {
  system: "跟隨系統",
  light: "淺色",
  dark: "深色",
};
const icons = {
  system: "◐",
  light: "☀",
  dark: "☾",
};
const themeColors = {
  light: "#f7f7f5",
  dark: "#0f0f10",
};

export function normalizeThemePreference(value) {
  return preferences.includes(value) ? value : "system";
}

export function createThemeController({ window, document }) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listeners = [];
  let preference = "system";
  try {
    preference = normalizeThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }

  function resolvedTheme() {
    return preference === "system" ? (media.matches ? "dark" : "light") : preference;
  }

  function apply() {
    const theme = resolvedTheme();
    const root = document.documentElement;
    root.dataset.themePreference = preference;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    root.classList.toggle("theme-light", theme === "light");
    root.classList.toggle("theme-dark", theme === "dark");

    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", themeColors[theme]);
    for (const select of document.querySelectorAll("[data-theme-select]")) {
      select.value = preference;
    }
    for (const button of document.querySelectorAll("[data-theme-toggle]")) {
      button.textContent = icons[preference];
      button.title = `配色：${labels[preference]}`;
      button.setAttribute("aria-label", `配色：${labels[preference]}，按下切換`);
      button.setAttribute("data-theme-current", preference);
    }
    return theme;
  }

  function setPreference(value) {
    preference = normalizeThemePreference(value);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      // Keep the current document usable when storage is blocked or full.
    }
    apply();
  }

  function bind(target, event, listener) {
    target.addEventListener(event, listener);
    listeners.push(() => target.removeEventListener(event, listener));
  }

  function handleStorage(event) {
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    preference = normalizeThemePreference(event.newValue);
    apply();
  }

  function handleSystemChange() {
    if (preference === "system") apply();
  }

  bind(window, "storage", handleStorage);
  bind(media, "change", handleSystemChange);
  for (const select of document.querySelectorAll("[data-theme-select]")) {
    bind(select, "change", (event) => setPreference(event.currentTarget.value));
  }
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    bind(button, "click", () => {
      const index = preferences.indexOf(preference);
      setPreference(preferences[(index + 1) % preferences.length]);
    });
  }

  apply();
  return {
    get preference() { return preference; },
    get resolved() { return resolvedTheme(); },
    setPreference,
    apply,
    dispose() {
      for (const remove of listeners.splice(0)) remove();
    },
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  createThemeController({ window, document });
}
