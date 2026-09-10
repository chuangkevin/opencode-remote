import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleCompactStatic } from "../dist/compact/handlers.js";
import { renderCompactShell } from "../dist/compact/shell.js";
import {
  THEME_STORAGE_KEY,
  createThemeController,
} from "../static/theme.js";

function fixture(storedPreference, systemDark = false, storageErrors = {}) {
  const attributes = new Map();
  const classes = new Set();
  const windowListeners = new Map();
  const mediaListeners = new Set();
  const storage = new Map();
  if (storedPreference !== undefined) storage.set(THEME_STORAGE_KEY, storedPreference);

  const meta = {
    content: "",
    setAttribute(name, value) {
      if (name === "content") this.content = value;
    },
  };
  const selectListeners = new Map();
  const toggleListeners = new Map();
  const select = {
    value: "",
    addEventListener(name, listener) { selectListeners.set(name, listener); },
    removeEventListener(name) { selectListeners.delete(name); },
  };
  const toggle = {
    textContent: "",
    title: "",
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(name, listener) { toggleListeners.set(name, listener); },
    removeEventListener(name) { toggleListeners.delete(name); },
  };
  const document = {
    documentElement: {
      dataset: {},
      style: {},
      classList: {
        toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      },
      setAttribute(name, value) { attributes.set(name, value); },
    },
    querySelector(selector) {
      return selector === 'meta[name="theme-color"]' ? meta : null;
    },
    querySelectorAll(selector) {
      if (selector === "[data-theme-select]") return [select];
      if (selector === "[data-theme-toggle]") return [toggle];
      return [];
    },
  };
  const media = {
    matches: systemDark,
    addEventListener(name, listener) { if (name === "change") mediaListeners.add(listener); },
    removeEventListener(name, listener) { if (name === "change") mediaListeners.delete(listener); },
  };
  const window = {
    localStorage: {
      getItem(key) {
        if (storageErrors.get) throw new DOMException("blocked", "SecurityError");
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (storageErrors.set) throw new DOMException("full", "QuotaExceededError");
        storage.set(key, value);
      },
    },
    matchMedia() { return media; },
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener(name) { windowListeners.delete(name); },
  };

  return { attributes, classes, document, media, mediaListeners, meta, select, selectListeners, storage, toggle, toggleListeners, window, windowListeners };
}

test("initializes light, dark, and system preferences", () => {
  for (const [preference, systemDark, expected] of [
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["system", false, "light"],
    ["system", true, "dark"],
  ]) {
    const env = fixture(preference, systemDark);
    const controller = createThemeController(env);
    assert.equal(env.document.documentElement.dataset.themePreference, preference);
    assert.equal(env.document.documentElement.dataset.theme, expected);
    assert.equal(env.document.documentElement.style.colorScheme, expected);
    assert.equal(env.select.value, preference);
    assert.equal(env.classes.has(`theme-${expected}`), true);
    controller.dispose();
  }
});

test("applies same-document changes and writes the native OpenCode key", () => {
  const env = fixture("system", true);
  const controller = createThemeController(env);

  env.toggleListeners.get("click")();

  assert.equal(env.storage.get(THEME_STORAGE_KEY), "light");
  assert.equal(env.document.documentElement.dataset.theme, "light");
  assert.equal(env.meta.content, "#f7f7f5");
  assert.match(env.toggle.attributes.get("aria-label"), /淺色/);
  controller.dispose();
});

test("syncs storage changes from another tab", () => {
  const env = fixture("light", false);
  const controller = createThemeController(env);

  env.windowListeners.get("storage")({ key: THEME_STORAGE_KEY, newValue: "dark" });

  assert.equal(controller.preference, "dark");
  assert.equal(env.document.documentElement.dataset.theme, "dark");
  assert.equal(env.meta.content, "#0f0f10");
  controller.dispose();
});

test("resets to system when another tab clears localStorage", () => {
  const env = fixture("dark", false);
  const controller = createThemeController(env);

  env.windowListeners.get("storage")({ key: null, newValue: null });

  assert.equal(controller.preference, "system");
  assert.equal(controller.resolved, "light");
  assert.equal(env.meta.content, "#f7f7f5");
  controller.dispose();
});

test("tracks OS changes only while preference is system", () => {
  const env = fixture("system", false);
  const controller = createThemeController(env);
  env.media.matches = true;
  for (const listener of env.mediaListeners) listener({ matches: true });
  assert.equal(env.document.documentElement.dataset.theme, "dark");

  controller.setPreference("light");
  env.media.matches = false;
  for (const listener of env.mediaListeners) listener({ matches: false });
  assert.equal(env.document.documentElement.dataset.theme, "light");
  controller.dispose();
});

test("defaults to system when localStorage reads throw", () => {
  const env = fixture(undefined, true, { get: true });

  const controller = createThemeController(env);

  assert.equal(controller.preference, "system");
  assert.equal(controller.resolved, "dark");
  assert.equal(env.meta.content, "#0f0f10");
  controller.dispose();
});

test("applies in-memory changes when localStorage writes throw", () => {
  const env = fixture("dark", false, { set: true });
  const controller = createThemeController(env);

  assert.doesNotThrow(() => controller.setPreference("light"));
  assert.equal(controller.preference, "light");
  assert.equal(env.document.documentElement.dataset.theme, "light");
  assert.equal(env.meta.content, "#f7f7f5");
  controller.dispose();
});

test("serves theme.js from the compact static allowlist", () => {
  let status;
  let headers;
  let body;
  const response = {
    writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders; },
    end(nextBody) { body = nextBody; },
  };

  handleCompactStatic({ url: "/c/static/theme.js" }, response);

  assert.equal(status, 200);
  assert.equal(headers["Content-Type"], "application/javascript; charset=utf-8");
  assert.match(body.toString("utf8"), /opencode-color-scheme/);

  handleCompactStatic({ url: "/c/static/not-theme.js" }, response);
  assert.equal(status, 404);
});

test("all custom shells initialize and expose the shared theme control", async () => {
  const compact = renderCompactShell("ses_theme", "/workspace");
  const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const mockup = await readFile(new URL("../../../mockups/compact-mockup.html", import.meta.url), "utf8");
  const debug = index.slice(index.indexOf("function handleRemoteDebug"), index.indexOf("function handleRemoteClientDebug"));
  const sessions = index.slice(index.indexOf("async function handleRemoteSessions"), index.indexOf("async function handleListPins"));

  for (const shell of [compact, debug, sessions, mockup]) {
    assert.match(shell, /opencode-color-scheme/);
    assert.match(shell, /data-theme-toggle/);
    assert.match(shell, /\/c\/static\/theme\.js/);
    assert.match(shell, /meta name="theme-color"/);
    assert.match(shell, /querySelector\('meta\[name="theme-color"\]'\)/);
    assert.match(shell, /"#f7f7f5"/);
    assert.match(shell, /"#0f0f10"/);
    assert.ok(shell.indexOf("querySelector('meta[name=\"theme-color\"]')") < shell.indexOf('<script type="module" src="/c/static/theme.js"></script>'));
  }
  assert.match(index, /OpenCode Sessions/);
  assert.match(index, /OpenCode Remote Debug/);
  assert.equal(index.match(/data-theme-toggle/g)?.length, 2);
  assert.equal(index.match(/<script type="module" src="\/c\/static\/theme\.js"><\/script>/g)?.length, 2);
  assert.equal(index.match(/querySelector\('meta\[name="theme-color"\]'\)/g)?.length, 2);
});

test("compact and inline shells define light tokens for interactive states", async () => {
  const css = await readFile(new URL("../static/compact.css", import.meta.url), "utf8");
  const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const mockup = await readFile(new URL("../../../mockups/compact-mockup.html", import.meta.url), "utf8");

  assert.match(css, /:root\[data-theme="light"\]/);
  for (const token of ["--header-bg", "--code-bg", "--overlay-bg", "--selected-bg", "--attachment-remove-bg", "--queued-text", "--disabled-bg", "--disabled-text", "--send-disabled-bg", "--send-disabled-text", "--send-disabled-border"]) {
    assert.match(css, new RegExp(token));
  }
  for (const state of ["\.header-menu", "\.msg\.queued", "\.thinking-indicator", "\.qcard", "\.picker", "\.attach-row"]) {
    assert.match(css, new RegExp(state));
  }
  assert.match(index, /:root\[data-theme="light"\]/);
  assert.match(mockup, /:root\[data-theme="light"\]/);
  assert.doesNotMatch(css, /\.msg\.queued\s*\{[^}]*opacity:/s);
  assert.match(css, /\.qcard-submit:disabled\s*\{[^}]*color:\s*var\(--disabled-text\)/s);
  assert.match(css, /\.add-provider-save:disabled\s*\{[^}]*color:\s*var\(--disabled-text\)/s);
  assert.match(css, /\.send-btn:disabled\s*\{[^}]*opacity:\s*1[^}]*background:\s*var\(--send-disabled-bg\)[^}]*border-color:\s*var\(--send-disabled-border\)[^}]*color:\s*var\(--send-disabled-text\)/s);
  for (const token of ["--queued-text", "--disabled-bg", "--disabled-text"]) {
    assert.match(mockup, new RegExp(token));
  }
  assert.doesNotMatch(mockup, /\.msg\.queued\s*\{[^}]*opacity:/s);
  assert.match(mockup, /\.qopt:disabled\s*\{[^}]*background:\s*var\(--disabled-bg\)/s);
  assert.match(mockup, /\.add-provider-save:disabled\s*\{[^}]*color:\s*var\(--disabled-text\)/s);
});

test("compact removal and variant controls have accessible touch targets", async () => {
  const css = await readFile(new URL("../static/compact.css", import.meta.url), "utf8");
  const client = await readFile(new URL("../static/compact.js", import.meta.url), "utf8");
  const mockup = await readFile(new URL("../../../mockups/compact-mockup.html", import.meta.url), "utf8");

  assert.match(client, /<button class="x" type="button" data-i="\$\{i\}" aria-label="移除附件"><span aria-hidden="true">×<\/span><\/button>/);
  for (const selector of ["attach-thumb \\.x", "msg\\.queued \\.queue-remove"]) {
    const rule = new RegExp(`\\.${selector}\\s*\\{[^}]*(?:width|min-height):\\s*44px`, "s");
    assert.match(css, rule);
    assert.match(mockup, rule);
  }
  const variantRule = /\.variant-pill\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s;
  assert.match(css, variantRule);
  assert.match(mockup, variantRule);
  assert.match(css, /\.variants\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(mockup, /<button class="x" type="button" aria-label="移除附件"><span aria-hidden="true">×<\/span><\/button>/);
  assert.match(mockup, /--send-disabled-bg/);
});
