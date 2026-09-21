import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

// 2026-09-21：compact 選模型清單對「使用者自己寫進 opencode.jsonc 的 provider」不能再用
// cost==0 過濾——newapi 的模型有 models.dev 成本資料後，87 個只剩 21 個，跟 desktop 不同步。
// 內建的 opencode（Zen）provider 仍只列免費模型。
test("compact picker lists every model of configured providers, free-only for built-in opencode", async () => {
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/provider") {
      res.end(JSON.stringify({
        all: [
          { id: "opencode", name: "OpenCode", models: {
            "free-a": { id: "free-a", cost: { input: 0, output: 0 } },
            "paid-b": { id: "paid-b", cost: { input: 1, output: 2 } },
          } },
          { id: "newapi", name: "New API (chat)", models: {
            "gb10": { id: "gb10" },
            "go/kimi-k3": { id: "go/kimi-k3", cost: { input: 3, output: 15 } },
            "retired": { id: "retired", status: "deprecated", cost: { input: 0, output: 0 } },
          } },
          { id: "openai", name: "OpenAI", models: { "gpt": { id: "gpt", cost: { input: 0, output: 0 } } } },
          { id: "random-free", name: "Random", models: { "x": { id: "x", cost: { input: 0, output: 0 } } } },
        ],
      }));
      return;
    }
    if (req.url === "/config") {
      res.end(JSON.stringify({ provider: { newapi: {}, openai: {} } }));
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
  const res = {
    writeHead() {},
    setHeader() {},
    end(body) { chunks.push(String(body ?? "")); },
  };
  await handleCompactProviders(res);
  upstream.close();
  const list = JSON.parse(chunks.join(""));
  const byId = Object.fromEntries(list.map((p) => [p.id, p.models.map((m) => m.id).sort()]));
  assert.deepEqual(byId.newapi, ["gb10", "go/kimi-k3"], "configured provider keeps paid models, drops non-active");
  assert.deepEqual(byId.opencode, ["free-a"], "built-in opencode stays free-only");
  assert.equal(byId.openai, undefined, "openai is excluded from the compact picker");
  assert.equal(byId["random-free"], undefined, "providers not in config are not listed");
});
