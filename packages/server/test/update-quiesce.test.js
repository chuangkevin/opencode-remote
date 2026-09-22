import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { rejectPromptWhileQuiesced } from "../dist/update-quiesce.js";

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

test("quiesce marker rejects only prompt-creating session POST routes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "opencode-update-quiesce-"));
  t.after(async () => {
    await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true }));
  });
  const marker = join(root, "update.quiesce");
  await writeFile(marker, "owner");

  for (const url of [
    "/api/session/ses_abc123/prompt",
    "/api/session/ses_abc123/command?directory=%2Fworkspace",
  ]) {
    const res = responseRecorder();
    assert.equal(rejectPromptWhileQuiesced({ method: "POST", url }, res, marker), true, url);
    assert.equal(res.status, 503);
    assert.equal(res.headers["Retry-After"], "1");
    assert.equal(res.headers["Cache-Control"], "no-store");
    assert.deepEqual(JSON.parse(res.body), { error: "OpenCode Remote is updating; retry shortly" });
  }

  for (const [method, url] of [
    ["POST", "/session"],
    ["POST", "/api/session/ses_abc123/interrupt"],
    ["POST", "/c/pins/ses_abc123"],
    ["GET", "/c/session-status?directory=%2Fworkspace"],
    ["GET", "/api/session/ses_abc123/message"],
  ]) {
    assert.equal(rejectPromptWhileQuiesced({ method, url }, responseRecorder(), marker), false, `${method} ${url}`);
  }
});

test("quiesce guard is disabled without a configured or existing marker", () => {
  const request = { method: "POST", url: "/api/session/ses_abc123/prompt" };
  assert.equal(rejectPromptWhileQuiesced(request, responseRecorder(), undefined), false);
  assert.equal(rejectPromptWhileQuiesced(request, responseRecorder(), "/definitely/missing/quiesce"), false);
});

test("server applies quiesce before general proxying", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const guard = source.indexOf("rejectPromptWhileQuiesced(req, res, config.updateQuiesceFile)");
  const serverStart = source.indexOf("const server = http.createServer(");
  const fallbackProxy = source.indexOf("\n  proxy(req, res);", serverStart);
  assert.ok(guard >= 0 && serverStart >= 0 && guard > serverStart && guard < fallbackProxy);
});
