import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DESKTOP_STATUS_TIMEOUT_MS,
  handleMergedSessionStatus,
  isPathWithinRoot,
  mergeSessionStatuses,
  OWN_STATUS_TIMEOUT_MS,
  parseDesktopConnection,
  readDesktopConnection,
} from "../dist/compact/session-status.js";
import { loadSessionStatuses } from "../static/remote-sessions.js";

const credential = {
  origin: "http://127.0.0.1:54321",
  username: "desktop-user",
  password: "desktop-secret",
  pid: process.pid,
  updatedAt: Date.now(),
};

function responseRecorder() {
  return {
    status: undefined,
    headers: undefined,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body += body;
    },
  };
}

function statusFetch(routes, expectedDirectory = "/Users/kevin/Documents/Projects") {
  return async (input, options = {}) => {
    const url = new URL(String(input));
    const route = routes[url.origin];
    if (route instanceof Error) throw route;
    if (!route) return new Response("missing", { status: 503 });
    if (url.origin === credential.origin) {
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`);
    }
    assert.equal(url.pathname, "/session/status");
    assert.equal(url.searchParams.get("directory"), expectedDirectory);
    return Response.json(route);
  };
}

test("credential parser rejects malformed and non-loopback data", () => {
  assert.equal(parseDesktopConnection("not-json"), undefined);
  assert.equal(parseDesktopConnection(JSON.stringify({ ...credential, origin: "https://example.com" })), undefined);
  assert.equal(parseDesktopConnection(JSON.stringify({ ...credential, username: "" })), undefined);
  assert.equal(parseDesktopConnection(JSON.stringify({ ...credential, password: "" })), undefined);
  assert.equal(parseDesktopConnection(JSON.stringify({ ...credential, pid: 1.5 })), undefined);
  assert.equal(parseDesktopConnection(JSON.stringify({ ...credential, updatedAt: "now" })), undefined);
  assert.equal(parseDesktopConnection(JSON.stringify({ ...credential, updatedAt: credential.updatedAt - 15 * 60_000 - 1 }), credential.updatedAt), undefined);
  assert.equal(parseDesktopConnection(JSON.stringify({ ...credential, updatedAt: credential.updatedAt + 60_001 }), credential.updatedAt), undefined);
  assert.deepEqual(parseDesktopConnection(JSON.stringify({ ...credential, updatedAt: credential.updatedAt - 15 * 60_000 }), credential.updatedAt), {
    ...credential,
    updatedAt: credential.updatedAt - 15 * 60_000,
  });
  assert.deepEqual(parseDesktopConnection(JSON.stringify(credential)), credential);
});

test("directory authorization accepts only the configured root and descendants", () => {
  const root = "/Users/kevin/Documents/Projects";
  assert.equal(isPathWithinRoot(root, root), true);
  assert.equal(isPathWithinRoot(join(root, "private-codebase", "opencode-remote"), root), true);
  assert.equal(isPathWithinRoot(`${root}-sibling`, root), false);
  assert.equal(isPathWithinRoot(join(root, "..", "private"), root), false);
  assert.equal(isPathWithinRoot("relative/path", root), false);
});

test("credential reader rejects non-private files and stale processes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-remote-status-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
  const filePath = join(root, "desktop-connection.json");

  await writeFile(filePath, JSON.stringify(credential), { mode: 0o644 });
  assert.equal(await readDesktopConnection(filePath), undefined);

  await chmod(filePath, 0o600);
  await writeFile(filePath, JSON.stringify({ ...credential, pid: 2_147_483_647 }));
  assert.equal(await readDesktopConnection(filePath), undefined);

  await writeFile(filePath, "x".repeat(16 * 1024 + 1));
  assert.equal(await readDesktopConnection(filePath), undefined);

  await writeFile(filePath, JSON.stringify(credential));
  assert.deepEqual(await readDesktopConnection(filePath), credential);
});

test("credential reader rejects symbolic links when O_NOFOLLOW is supported", async (t) => {
  if (!constants.O_NOFOLLOW) return t.skip("O_NOFOLLOW is unavailable");
  const root = await mkdtemp(join(tmpdir(), "opencode-remote-status-link-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
  const targetPath = join(root, "target.json");
  const linkPath = join(root, "desktop-connection.json");
  await writeFile(targetPath, JSON.stringify(credential), { mode: 0o600 });
  try {
    await symlink(targetPath, linkPath);
  } catch (error) {
    if (["EPERM", "ENOSYS"].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`);
    throw error;
  }
  assert.equal(await readDesktopConnection(linkPath), undefined);
});

test("status merge returns own upstream when Desktop is unavailable", async () => {
  assert.deepEqual(await mergeSessionStatuses("/Users/kevin/Documents/Projects", {
    ownOrigin: "http://127.0.0.1:4196",
    desktopConnection: credential,
    fetchFn: statusFetch({
      "http://127.0.0.1:4196": { ses_own: { type: "busy" } },
      [credential.origin]: new Error("desktop offline"),
    }),
  }), { ses_own: { type: "busy" } });
});

test("strict status merge requires both own and live Desktop sources", async () => {
  await assert.rejects(mergeSessionStatuses("/Users/kevin/Documents/Projects", {
    ownOrigin: "http://127.0.0.1:4196",
    desktopConnection: credential,
    strict: true,
    fetchFn: statusFetch({
      "http://127.0.0.1:4196": { ses_own: { type: "idle" } },
      [credential.origin]: new Error("desktop offline"),
    }),
  }), /session status unavailable/);

  await assert.rejects(mergeSessionStatuses("/Users/kevin/Documents/Projects", {
    ownOrigin: "http://127.0.0.1:4196",
    desktopConnection: credential,
    strict: true,
    fetchFn: statusFetch({
      "http://127.0.0.1:4196": new Error("own offline"),
      [credential.origin]: { ses_desktop: { type: "idle" } },
    }),
  }), /session status unavailable/);

  assert.deepEqual(await mergeSessionStatuses("/Users/kevin/Documents/Projects", {
    ownOrigin: "http://127.0.0.1:4196",
    strict: true,
    fetchFn: statusFetch({
      "http://127.0.0.1:4196": { ses_own: { type: "idle" } },
    }),
  }), { ses_own: { type: "idle" } });
});

test("nine directory batches finish inside the browser budget when Desktop hangs", async () => {
  const directoryCount = 9;
  const browserConcurrency = 4;
  const browserTimeoutMs = 3_000;
  assert.ok(Math.ceil(directoryCount / browserConcurrency) * DESKTOP_STATUS_TIMEOUT_MS < browserTimeoutMs);
  assert.equal(OWN_STATUS_TIMEOUT_MS, 1_500);

  const directories = Array.from({ length: directoryCount }, (_, index) => `/workspace/${index}`);
  const statuses = await loadSessionStatuses(directories, AbortSignal.timeout(browserTimeoutMs), async (input) => {
    const directory = new URL(String(input), "http://remote.test").searchParams.get("directory");
    const merged = await mergeSessionStatuses(directory, {
      ownOrigin: "http://127.0.0.1:4196",
      desktopConnection: credential,
      ownTimeoutMs: 50,
      desktopTimeoutMs: 15,
      fetchFn: async (source, options = {}) => {
        const sourceUrl = new URL(String(source));
        if (sourceUrl.origin === "http://127.0.0.1:4196") {
          return Response.json({ [`ses_${directory.split("/").at(-1)}`]: { type: "busy" } });
        }
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    });
    return Response.json(merged);
  });

  assert.equal(Object.keys(statuses).length, directoryCount);
  assert.ok(Object.values(statuses).every((status) => status.type === "busy"));
});

test("status merge returns Desktop when own upstream is unavailable", async () => {
  assert.deepEqual(await mergeSessionStatuses("/Users/kevin/Documents/Projects", {
    ownOrigin: "http://127.0.0.1:4196",
    desktopConnection: credential,
    fetchFn: statusFetch({
      "http://127.0.0.1:4196": new Error("own offline"),
      [credential.origin]: { ses_desktop: { type: "busy" } },
    }),
  }), { ses_desktop: { type: "busy" } });
});

test("status merge combines both sources and busy Desktop wins an idle duplicate", async () => {
  assert.deepEqual(await mergeSessionStatuses("/Users/kevin/Documents/Projects", {
    ownOrigin: "http://127.0.0.1:4196",
    desktopConnection: credential,
    fetchFn: statusFetch({
      "http://127.0.0.1:4196": {
        ses_own: { type: "busy" },
        ses_shared_idle: { type: "idle" },
        ses_shared_retry: { type: "retry" },
        ses_shared_unknown: { type: "something-else" },
      },
      [credential.origin]: {
        ses_desktop: { type: "busy" },
        ses_shared_idle: { type: "busy" },
        ses_shared_retry: { type: "busy" },
        ses_shared_unknown: { type: "busy" },
      },
    }),
  }), {
    ses_own: { type: "busy" },
    ses_shared_idle: { type: "busy" },
    ses_shared_retry: { type: "busy" },
    ses_shared_unknown: { type: "busy" },
    ses_desktop: { type: "busy" },
  });
});

test("status merge preserves busy own status when Desktop duplicate is idle", async () => {
  assert.deepEqual(await mergeSessionStatuses("/Users/kevin/Documents/Projects", {
    ownOrigin: "http://127.0.0.1:4196",
    desktopConnection: credential,
    fetchFn: statusFetch({
      "http://127.0.0.1:4196": {
        ses_own: { type: "idle" },
        ses_shared_idle: { type: "busy" },
        ses_shared_retry: { type: "busy" },
        ses_shared_unknown: { type: "busy" },
      },
      [credential.origin]: {
        ses_desktop: { type: "retry" },
        ses_shared_idle: { type: "idle" },
        ses_shared_retry: { type: "retry" },
        ses_shared_unknown: { type: "something-else" },
      },
    }),
  }), {
    ses_own: { type: "idle" },
    ses_shared_idle: { type: "busy" },
    ses_shared_retry: { type: "busy" },
    ses_shared_unknown: { type: "busy" },
    ses_desktop: { type: "retry" },
  });
});

test("merged endpoint returns 502 when both sources fail without leaking credentials", async () => {
  const res = responseRecorder();
  const logs = [];
  const directory = process.cwd();
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  try {
    await handleMergedSessionStatus(
      { method: "GET", url: `/c/session-status?directory=${encodeURIComponent(directory)}` },
      res,
      {
        ownOrigin: "http://127.0.0.1:4196",
        allowedRoot: directory,
        loadDesktopConnection: async () => credential,
        fetchFn: statusFetch({
          "http://127.0.0.1:4196": new Error("own offline"),
          [credential.origin]: new Error("desktop offline"),
        }, directory),
      },
    );
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }

  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(res.body), { error: "session status unavailable" });
  const observable = `${res.body}\n${logs.join("\n")}`;
  assert.doesNotMatch(observable, /desktop-user|desktop-secret/);
});

test("strict merged endpoint returns 502 instead of using a successful fallback", async () => {
  const res = responseRecorder();
  const directory = process.cwd();
  await handleMergedSessionStatus(
    { method: "GET", url: `/c/session-status?strict=1&directory=${encodeURIComponent(directory)}` },
    res,
    {
      ownOrigin: "http://127.0.0.1:4196",
      allowedRoot: directory,
      loadDesktopConnection: async () => credential,
      fetchFn: statusFetch({
        "http://127.0.0.1:4196": { ses_own: { type: "idle" } },
        [credential.origin]: new Error("desktop offline"),
      }, directory),
    },
  );

  assert.equal(res.status, 502);
  assert.deepEqual(JSON.parse(res.body), { error: "session status unavailable" });
});

test("merged endpoint validates an absolute bounded directory", async () => {
  for (const directory of ["relative/path", "", `/${"a".repeat(4097)}`]) {
    const res = responseRecorder();
    await handleMergedSessionStatus(
      { method: "GET", url: `/c/session-status?directory=${encodeURIComponent(directory)}` },
      res,
      { allowedRoot: "/Users/kevin/Documents/Projects", loadDesktopConnection: async () => credential },
    );
    assert.equal(res.status, 400);
  }
});

test("merged endpoint rejects directories outside its allowed root", async () => {
  for (const directory of [
    "/Users/kevin/Documents/Projects-sibling",
    "/Users/kevin/Documents/Projects/../private",
    "/tmp/other-project",
  ]) {
    const res = responseRecorder();
    await handleMergedSessionStatus(
      { method: "GET", url: `/c/session-status?directory=${encodeURIComponent(directory)}` },
      res,
      { allowedRoot: "/Users/kevin/Documents/Projects", loadDesktopConnection: async () => credential },
    );
    assert.equal(res.status, 400, directory);
  }
});

test("merged endpoint rejects nonexistent and symlink-escaped directories before status fetch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-remote-root-"));
  const outside = await mkdtemp(join(tmpdir(), "opencode-remote-outside-"));
  t.after(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });
  await mkdir(join(root, "inside"));
  const escaped = join(root, "escaped");
  try {
    await symlink(outside, escaped, "dir");
  } catch (error) {
    if (["EPERM", "ENOSYS"].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`);
    throw error;
  }

  let fetchCalls = 0;
  for (const directory of [join(root, "missing"), escaped]) {
    const res = responseRecorder();
    await handleMergedSessionStatus(
      { method: "GET", url: `/c/session-status?directory=${encodeURIComponent(directory)}` },
      res,
      {
        ownOrigin: "http://127.0.0.1:4196",
        allowedRoot: root,
        loadDesktopConnection: async () => credential,
        fetchFn: async () => {
          fetchCalls += 1;
          return Response.json({});
        },
      },
    );
    assert.equal(res.status, 400, directory);
  }
  assert.equal(fetchCalls, 0);
});
