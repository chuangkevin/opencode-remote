import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

// 2026-09-21 Kevin：「我不想要每次 remote 跟 desktop 都不同步」。
// compact 選模型清單 = OpenCode /provider 的 connected 清單，一個不多一個不少；
// 不再有 allowlist、免費過濾、排除清單。只丟掉 status 不是 active 的模型。
test("compact picker groups OpenCode 2.x /api/model by provider and sends Basic auth", async () => {
  let seenAuth = null;
  let seenPath = null;
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/api/model")) {
      seenAuth = req.headers.authorization ?? null;
      seenPath = req.url;
      res.end(JSON.stringify({ location: { directory: "/w" }, data: [
        { id: "free-a", providerID: "opencode", name: "Free A" },
        { id: "paid-b", providerID: "opencode", name: "Paid B", variants: [{ id: "high", settings: {} }, { id: "low" }] },
        { id: "gb10", providerID: "newapi", name: "GB10" },
        { id: "gpt", providerID: "openai", name: "GPT", variants: [] },
        { id: "no-provider" },
      ] }));
      return;
    }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  const port = upstream.address().port;
  process.env.OPENCODE_PORT = String(port);
  process.env.OPENCODE_SERVER_PASSWORD = "pw-test";
  process.env.OPENCODE_DIRECTORY = "/w";
  const { handleCompactProviders } = await import("../dist/compact/handlers.js");

  const chunks = [];
  const res = { writeHead() {}, setHeader() {}, end(body) { chunks.push(String(body ?? "")); } };
  await handleCompactProviders(res);
  upstream.close();
  const list = JSON.parse(chunks.join(""));
  const byId = Object.fromEntries(list.map((p) => [p.id, p.models.map((m) => m.id).sort()]));
  assert.deepEqual(Object.keys(byId).sort(), ["newapi", "openai", "opencode"], "one entry per provider");
  assert.deepEqual(byId.opencode, ["free-a", "paid-b"]);
  assert.deepEqual(byId.newapi, ["gb10"]);
  const paidB = list.find((p) => p.id === "opencode").models.find((m) => m.id === "paid-b");
  assert.deepEqual(paidB.variants, ["high", "low"], "variant objects become a name list");
  const gpt = list.find((p) => p.id === "openai").models[0];
  assert.equal(gpt.variants, null, "empty variants collapse to null");
  assert.equal(seenAuth, `Basic ${Buffer.from("opencode:pw-test").toString("base64")}`);
  assert.equal(new URL(seenPath, "http://x").searchParams.get("location[directory]"), "/w");
});
