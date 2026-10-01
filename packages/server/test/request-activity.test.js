import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import test from "node:test";

import { evaluateHealthRecovery, fetchHealthRecoveryActivityStatus, trackPromptRequest } from "../dist/health-watchdog.js";

function fakeRequest(method, url) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  return request;
}

function fakeResponse() {
  return new EventEmitter();
}

test("prompt activity counts recognized prompt POSTs and cleans once on every terminal path", () => {
  const active = new Set();
  const cases = [
    ["finish", (req, res) => res.emit("finish")],
    ["close after finish", (req, res) => { res.emit("finish"); res.emit("close"); }],
    ["upstream error", (req) => req.emit("error", new Error("upstream failed"))],
    ["client abort", (req) => req.emit("aborted")],
  ];

  for (const [name, terminate] of cases) {
    const req = fakeRequest("POST", "/api/session/ses_abc123/prompt_async");
    const res = fakeResponse();
    trackPromptRequest(req, res, active);
    assert.equal(active.size, 1, `${name}: registered`);
    terminate(req, res);
    assert.equal(active.size, 0, `${name}: cleaned`);
    req.emit("aborted");
    res.emit("close");
    assert.equal(active.size, 0, `${name}: cleanup remains exact-once`);
  }
});

test("non-prompt requests do not count as active generation", () => {
  const active = new Set();
  trackPromptRequest(fakeRequest("POST", "/api/session/ses_abc123/interrupt"), fakeResponse(), active);
  trackPromptRequest(fakeRequest("GET", "/api/session/ses_abc123/prompt"), fakeResponse(), active);
  assert.equal(active.size, 0);
});

test("loopback HTTP boundary tracks prompt routes through terminal response events", async (t) => {
  const active = new Set();
  let promptAccepted;
  const accepted = new Promise((resolve) => { promptAccepted = resolve; });
  const server = http.createServer((req, res) => {
    trackPromptRequest(req, res, active);
    if (req.url === "/api/session/ses_http123/prompt_async") {
      promptAccepted();
      setTimeout(() => res.end("accepted"), 15);
      return;
    }
    res.end("ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const prompt = fetch(`${origin}/api/session/ses_http123/prompt_async`, { method: "POST" });
  await accepted;
  assert.equal(active.size, 1);
  await prompt;
  assert.equal(active.size, 0);

  await fetch(`${origin}/api/session/ses_http123/prompt`);
  await fetch(`${origin}/api/session/ses_http123/interrupt`, { method: "POST" });
  assert.equal(active.size, 0);
});

test("loopback client abort releases tracked prompt activity", async (t) => {
  const active = new Set();
  let accepted;
  const gotRequest = new Promise((resolve) => { accepted = resolve; });
  const server = http.createServer((req, res) => {
    trackPromptRequest(req, res, active);
    accepted();
    setTimeout(() => res.end("late"), 30);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${server.address().port}/api/session/ses_abort/prompt_async`, {
    method: "POST", body: "prompt", signal: controller.signal,
  }).catch(() => undefined);
  await gotRequest;
  assert.equal(active.size, 1);
  controller.abort();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(active.size, 0);
});

test("public recovery status helper classifies verified loopback responses", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/busy") res.end(JSON.stringify({ data: { one: { type: "running" } } }));
    else if (req.url === "/idle") res.end(JSON.stringify({ data: { one: { type: "idle" } } }));
    else if (req.url === "/retry") res.end(JSON.stringify({ data: { one: { type: "retry" } } }));
    else if (req.url === "/http-error") { res.writeHead(503); res.end("unavailable"); }
    else res.end("not-json");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await fetchHealthRecoveryActivityStatus((signal) => fetch(`${origin}/busy`, { signal }), 500), "busy");
  assert.equal(await fetchHealthRecoveryActivityStatus((signal) => fetch(`${origin}/idle`, { signal }), 500), "idle");
  assert.equal(await fetchHealthRecoveryActivityStatus((signal) => fetch(`${origin}/retry`, { signal }), 500), "busy");
  assert.equal(await fetchHealthRecoveryActivityStatus((signal) => fetch(`${origin}/http-error`, { signal }), 500), "unknown");
  assert.equal(await fetchHealthRecoveryActivityStatus((signal) => fetch(`${origin}/malformed`, { signal }), 500), "unknown");
});

test("recovery activity timeout aborts a response whose body is hanging", async (t) => {
  let socketClosed;
  const closed = new Promise((resolve) => { socketClosed = resolve; });
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"data":');
    res.on("close", socketClosed);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await fetchHealthRecoveryActivityStatus((signal) => fetch(origin, { signal }), 30), "unknown");
  const closeOutcome = await Promise.race([
    closed.then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
  ]);
  assert.equal(closeOutcome, "closed", "aborting the hanging response body must close its connection");
  assert.equal(server.closeAllConnections instanceof Function, true);
  server.closeAllConnections();
});

test("tracked prompt completed by early acknowledgement remains protected by busy activity status", async (t) => {
  const active = new Set();
  let accepted;
  const gotRequest = new Promise((resolve) => { accepted = resolve; });
  const server = http.createServer((req, res) => {
    trackPromptRequest(req, res, active);
    accepted();
    res.end("accepted");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${origin}/api/session/ses_early/prompt_async`, { method: "POST" });
  await gotRequest;
  assert.equal(active.size, 0);
  const statusServer = http.createServer((_req, res) => res.end(JSON.stringify({ data: { one: { type: "busy" } } })));
  await new Promise((resolve) => statusServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => statusServer.close((error) => error ? reject(error) : resolve())));
  const result = await fetchHealthRecoveryActivityStatus((signal) => fetch(`http://127.0.0.1:${statusServer.address().port}/status`, { signal }), 500);
  assert.equal(result, "busy");
  assert.equal(evaluateHealthRecovery({
    state: { consecutiveFailures: 0 }, probeOk: false, wallNow: 1_000, monotonicNow: 1_000,
    options: { failures: 1, restartCooldownMs: 0 }, activityStatus: result, activePrompts: active.size, ownedChildExited: false,
  }).action, "deferred");
});
