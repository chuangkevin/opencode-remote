import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { handleCompactStatic } from "../dist/compact/handlers.js";
import {
  FONT_SCALE_STORAGE_KEY,
  defaultFontScale,
  getFontScale,
  setFontScale,
} from "../static/font-scale.js";

function fixture(storedScale, mobile = false) {
  const storage = new Map();
  const calls = [];
  if (storedScale !== undefined) storage.set(FONT_SCALE_STORAGE_KEY, storedScale);
  const document = {
    documentElement: {
      style: {
        setProperty(name, value) {
          calls.push([name, value]);
        },
      },
    },
    querySelectorAll() {
      return [];
    },
  };
  const window = {
    localStorage: {
      getItem(key) {
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
    },
    matchMedia() {
      return { matches: mobile };
    },
  };
  return { calls, document, storage, window };
}

test("chooses the expected default font scale", () => {
  assert.equal(defaultFontScale({ window: fixture(undefined, true).window }), "1.3");
  assert.equal(defaultFontScale({ window: fixture(undefined, false).window }), "1");
});

test("reads stored font scale and falls back from invalid storage", () => {
  assert.equal(getFontScale({ window: fixture("1.3", true).window }), "1.3");
  assert.equal(getFontScale({ window: fixture("1.45", true).window }), "1.45");
  assert.equal(getFontScale({ window: fixture("2", true).window }), "1.3");
  assert.equal(getFontScale({ window: fixture("2", false).window }), "1");
});

test("setFontScale writes localStorage and applies the CSS variable", () => {
  const env = fixture(undefined, false);

  assert.equal(setFontScale("1.3", env), "1.3");

  assert.equal(env.storage.get(FONT_SCALE_STORAGE_KEY), "1.3");
  assert.deepEqual(env.calls.at(-1), ["--font-scale", "1.3"]);
});

test("compact static allowlist serves font-scale.js", () => {
  let status;
  let headers;
  let body;
  const response = {
    writeHead(nextStatus, nextHeaders) { status = nextStatus; headers = nextHeaders; },
    end(nextBody) { body = nextBody; },
  };

  handleCompactStatic({ url: "/c/static/font-scale.js" }, response);

  assert.equal(status, 200);
  assert.equal(headers["Content-Type"], "application/javascript; charset=utf-8");
  assert.match(body.toString("utf8"), /opencode-font-scale/);
});

test("compact stylesheet scales text without scaling touch target dimensions", async () => {
  const css = await readFile(new URL("../static/compact.css", import.meta.url), "utf8");

  assert.match(css, /\.msg-body\s*\{[^}]*font-size:\s*calc\(14px \* var\(--font-scale\)\)/s);
  assert.match(css, /\.compose\s*\{[^}]*font-size:\s*calc\(14px \* var\(--font-scale\)\)/s);

  const headerBack = css.match(/\.header-back\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px[^}]*\}/s);
  const iconBtn = css.match(/\.icon-btn\s*\{[^}]*width:\s*44px[^}]*height:\s*44px[^}]*\}/s);
  assert.ok(headerBack, "header back touch target should stay fixed at 44px");
  assert.ok(iconBtn, "icon button touch target should stay fixed at 44px");
  assert.doesNotMatch(headerBack[0], /var\(--font-scale\)/);
  assert.doesNotMatch(iconBtn[0], /var\(--font-scale\)/);
});

test("remote sessions page loads font scale and exposes the Aa control", async () => {
  const index = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const sessions = index.slice(index.indexOf("async function handleRemoteSessions"), index.indexOf("async function handleListPins"));

  assert.match(sessions, /\/c\/static\/font-scale\.js/);
  assert.match(sessions, /data-font-scale-cycle/);
  assert.match(sessions, />Aa<\/button>/);
});
