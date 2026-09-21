import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

// 2026-09-21 Kevin：「我不想要每次 remote 跟 desktop 都不同步」。
// compact 選模型清單 = OpenCode /provider 的 connected 清單，一個不多一個不少；
// 不再有 allowlist、免費過濾、排除清單。只丟掉 status 不是 active 的模型。
test("compact picker mirrors OpenCode's connected providers exactly", async () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/provider") {
      res.end(JSON.stringify({
        connected: ["opencode", "newapi", "openai"],
        all: [
          { id: "opencode", name: "OpenCode", models: {
            "free-a": { id: "free-a", cost: { input: 0, output: 0 } },
            "paid-b": { id: "paid-b", cost: { input: 1, output: 2 } },
          } },
          { id: "newapi", name: "New API (chat)", models: {
            "gb10": { id: "gb10" },
            "go/kimi-k3": { id: "go/kimi-k3", cost: { input: 3, output: 15 } },
            "retired": { id: "retired", status: "deprecated" },
          } },
          { id: "openai", name: "OpenAI", models: { "gpt": { id: "gpt", cost: { input: 0, output: 0 } } } },
          { id: "random-free", name: "Random", models: { "x": { id: "x", cost: { input: 0, output: 0 } } } },
        ],
      }));
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = upstream.address().port;
  process.env.OPENCODE_PORT = String(port);
  process.env.OPENCODE_DIRECTORY = process.env.OPENCODE_DIRECTORY || process.cwd();
  const { handleCompactProviders } = await import("../dist/compact/handlers.js");

  const chunks = [];
  const res = { writeHead() {}, setHeader() {}, end(body) { chunks.push(String(body ?? "")); } };
  await handleCompactProviders(res);
  upstream.close();
  const list = JSON.parse(chunks.join(""));
  const byId = Object.fromEntries(list.map((p) => [p.id, p.models.map((m) => m.id).sort()]));
  assert.deepEqual(Object.keys(byId).sort(), ["newapi", "openai", "opencode"], "exactly the connected providers");
  assert.deepEqual(byId.opencode, ["free-a", "paid-b"], "paid models are not hidden");
  assert.deepEqual(byId.newapi, ["gb10", "go/kimi-k3"], "non-active models are dropped");
  assert.deepEqual(byId.openai, ["gpt"]);
});
