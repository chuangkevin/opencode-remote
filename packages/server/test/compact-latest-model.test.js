import assert from "node:assert/strict";
import test from "node:test";

import {
  LatestUserModelBudgetError,
  LatestUserModelUpstreamError,
  findLatestUserModel,
} from "../dist/compact/model.js";
import {
  handleLatestUserModel,
  matchLatestUserModelPath,
} from "../dist/compact/handlers.js";

function message(id, role, created, model, variant) {
  return { info: { id, role, time: { created }, model, variant } };
}

function page(body, cursor, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: cursor ? { "content-type": "application/json", "x-next-cursor": cursor } : {
      "content-type": "application/json",
    },
  });
}

test("scans older cursor pages and follows the actual cursor header", async () => {
  const urls = [];
  const pages = [
    page(Array.from({ length: 30 }, (_, i) => message(`a${i}`, "assistant", 100 + i)), "cursor-page-2"),
    page(Array.from({ length: 30 }, (_, i) => message(`b${i}`, "assistant", 50 + i)), "cursor-page-3"),
    page([
      message("msg_older", "user", 1, { providerID: "openai", modelID: "gpt-5.5" }, "low"),
      message("msg_latest_user", "user", 2, { providerID: "openai", modelID: "gpt-5.6-sol" }, "medium"),
    ]),
  ];

  const result = await findLatestUserModel("http://upstream", "ses_valid", {
    fetch: async (url) => {
      urls.push(String(url));
      return pages.shift();
    },
  });

  assert.deepEqual(result, {
    model: { providerID: "openai", modelID: "gpt-5.6-sol", variant: "medium" },
    created: 2,
    messageID: "msg_latest_user",
  });
  assert.equal(urls.length, 3);
  assert.equal(new URL(urls[0]).searchParams.get("limit"), "30");
  assert.equal(new URL(urls[1]).searchParams.get("before"), "cursor-page-2");
  assert.equal(new URL(urls[2]).searchParams.get("before"), "cursor-page-3");
});

test("stops on the first page containing a valid user model", async () => {
  let calls = 0;
  const result = await findLatestUserModel("http://upstream", "ses_valid", {
    fetch: async () => {
      calls += 1;
      return page([
        message("msg_old", "user", 10, { providerID: "openai", modelID: "gpt-5.5" }),
        message("msg_new", "user", 20, { providerID: "openai", modelID: "gpt-5.6-sol" }, "medium"),
      ], "unused-cursor");
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.messageID, "msg_new");
});

test("returns model null only when pagination reaches its true end", async () => {
  const pages = [page([], "older"), page([])];
  assert.deepEqual(await findLatestUserModel("http://upstream", "ses_valid", {
    fetch: async () => pages.shift(),
  }), { model: null });
});

test("rejects a repeated upstream cursor as a scan budget failure", async () => {
  await assert.rejects(
    findLatestUserModel("http://upstream", "ses_valid", {
      fetch: async () => page([], "same-cursor"),
    }),
    LatestUserModelBudgetError,
  );
});

test("rejects upstream and parse failures instead of returning model null", async () => {
  await assert.rejects(
    findLatestUserModel("http://upstream", "ses_valid", {
      fetch: async () => page({ error: true }, null, 500),
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

test("rejects when the page budget is exhausted before pagination ends", async () => {
  let cursor = 0;
  await assert.rejects(
    findLatestUserModel("http://upstream", "ses_valid", {
      maxPages: 2,
      fetch: async () => page([], `cursor-${++cursor}`),
    }),
    LatestUserModelBudgetError,
  );
});

test("endpoint validates session ids and maps upstream versus budget failures", async () => {
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

    const upstreamFailure = await invoke(async () => page({ error: true }, null, 500));
    assert.equal(upstreamFailure.status, 502);
    assert.equal(upstreamFailure.headers["Cache-Control"], "no-store");

    const budgetFailure = await invoke(async () => page([], "repeat"));
    assert.equal(budgetFailure.status, 504);
    assert.equal(budgetFailure.headers["Cache-Control"], "no-store");

    const timeoutFailure = await invoke((_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), 5);
    assert.equal(timeoutFailure.status, 504);
    assert.equal(timeoutFailure.headers["Cache-Control"], "no-store");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
