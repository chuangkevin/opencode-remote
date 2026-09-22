import assert from "node:assert/strict";
import test from "node:test";

import {
  LatestUserModelUpstreamError,
  findLatestUserModel,
} from "../dist/compact/model.js";
import {
  handleLatestUserModel,
  matchLatestUserModelPath,
} from "../dist/compact/handlers.js";

// OpenCode 2.x keeps the session's current model on the session object
// (GET /api/session/:id → { data: { model: { id, providerID, variant } } }), so
// the picker reads that instead of scanning message history.
function sessionResponse(session, status = 200) {
  return new Response(JSON.stringify({ data: session }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("reads the session's current model from GET /api/session/:id", async () => {
  const urls = [];
  const headers = [];
  const result = await findLatestUserModel("http://upstream", "ses_valid", {
    headers: { authorization: "Basic abc" },
    fetch: async (url, init) => {
      urls.push(String(url));
      headers.push(init?.headers);
      return sessionResponse({
        id: "ses_valid",
        model: { id: "gpt-5.6-sol", providerID: "openai", variant: "medium" },
        time: { created: 1, updated: 2 },
      });
    },
  });

  assert.deepEqual(result, {
    model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "medium" },
    created: 2,
    messageID: null,
  });
  assert.deepEqual(urls, ["http://upstream/api/session/ses_valid"]);
  assert.deepEqual(headers[0], { authorization: "Basic abc" });
});

test("treats the 2.x 'default' variant as no variant and missing model as null", async () => {
  const withDefault = await findLatestUserModel("http://upstream", "ses_valid", {
    fetch: async () => sessionResponse({ model: { id: "gb10", providerID: "newapi", variant: "default" }, time: { updated: 5 } }),
  });
  assert.deepEqual(withDefault.model, { providerID: "newapi", modelID: "gb10", variant: null });

  assert.deepEqual(await findLatestUserModel("http://upstream", "ses_valid", {
    fetch: async () => sessionResponse({ id: "ses_valid", time: { updated: 5 } }),
  }), { model: null });
});

test("rejects upstream and parse failures instead of returning model null", async () => {
  await assert.rejects(
    findLatestUserModel("http://upstream", "ses_valid", {
      fetch: async () => sessionResponse({ error: true }, 500),
    }),
    LatestUserModelUpstreamError,
  );
  await assert.rejects(
    findLatestUserModel("http://upstream", "ses_valid", {
      fetch: async () => new Response("not json", { status: 200 }),
    }),
    LatestUserModelUpstreamError,
  );
});

test("endpoint validates session ids and maps upstream versus timeout failures", async () => {
  assert.equal(matchLatestUserModelPath("/c/session/ses_valid/latest-user-model"), "ses_valid");
  assert.equal(matchLatestUserModelPath("/c/session/not-a-session/latest-user-model"), undefined);

  const originalFetch = globalThis.fetch;
  const makeResponse = () => ({
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = "") { this.body = body; },
  });
  const invoke = async (fetchImpl, timeoutMs) => {
    globalThis.fetch = fetchImpl;
    const response = makeResponse();
    await handleLatestUserModel("ses_valid", response, timeoutMs);
    return response;
  };

  try {
    const invalid = makeResponse();
    await handleLatestUserModel("invalid", invalid);
    assert.equal(invalid.status, 400);

    const upstreamFailure = await invoke(async () => sessionResponse({ error: true }, 500));
    assert.equal(upstreamFailure.status, 502);
    assert.equal(upstreamFailure.headers["Cache-Control"], "no-store");

    const ok = await invoke(async () => sessionResponse({ model: { id: "m", providerID: "p" }, time: { updated: 1 } }));
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).model, { providerID: "p", modelID: "m", variant: null });

    const timeoutFailure = await invoke((_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), 5);
    assert.equal(timeoutFailure.status, 504);
    assert.equal(timeoutFailure.headers["Cache-Control"], "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
