import assert from "node:assert/strict";
import test from "node:test";

import {
  awaitPromptModel,
  chooseInitialModel,
  createLatestRequestRunner,
  createModelInitializationGate,
  latestUserMessageModel,
  needsAuthoritativeHistory,
  normalizePromptModel,
  reconcileModelAfterInitialization,
  reconcileHistoryModel,
} from "../static/compact-model.js";

const fallback = { providerID: "local-llm", modelID: "qwen2.5-vl-32b", variant: null };

function userMessage(created, providerID, modelID, variant) {
  return {
    info: {
      role: "user",
      time: { created },
      model: { providerID, modelID },
      ...(variant === undefined ? {} : { variant }),
    },
  };
}

test("latest user message model and variant override stale compact storage", () => {
  const history = [
    userMessage(10, "openai", "gpt-5.5", "medium"),
    { info: { role: "assistant", time: { created: 30 }, model: { providerID: "ignored", modelID: "ignored" } } },
    userMessage(20, "openai", "gpt-5.6", "xhigh"),
  ];

  assert.deepEqual(latestUserMessageModel(history), {
    providerID: "openai",
    modelID: "gpt-5.6",
    variant: "xhigh",
  });
  assert.deepEqual(chooseInitialModel({
    history,
    saved: { providerID: "openai", modelID: "gpt-5.5", variant: "low" },
    configured: fallback,
    fallback,
  }), {
    model: { providerID: "openai", modelID: "gpt-5.6", variant: "xhigh" },
    source: "history",
  });
});

test("initial model falls back through saved, config, then hard fallback", () => {
  const saved = { providerID: "openai", modelID: "gpt-5.5", variant: null };
  const configured = { providerID: "opencode", modelID: "big-pickle", variant: null };

  assert.deepEqual(chooseInitialModel({ history: [], saved, configured, fallback }), {
    model: saved,
    source: "saved",
  });
  assert.deepEqual(chooseInitialModel({ history: [], saved: null, configured, fallback }), {
    model: configured,
    source: "config",
  });
  assert.deepEqual(chooseInitialModel({ history: [], saved: null, configured: null, fallback }), {
    model: fallback,
    source: "fallback",
  });
});

test("history model accepts id alias and remains authoritative when absent from picker inventory", () => {
  const unknown = {
    info: {
      role: "user",
      time: { created: 1 },
      model: { providerID: "policy-hidden", id: "actual-session-model" },
    },
  };

  assert.deepEqual(latestUserMessageModel([unknown]), {
    providerID: "policy-hidden",
    modelID: "actual-session-model",
    variant: null,
  });
});

test("equal timestamps without message ids preserve batch last-wins ordering", () => {
  const history = [
    userMessage(10, "openai", "gpt-5.5", "low"),
    userMessage(10, "openai", "gpt-5.6", "high"),
  ];

  assert.deepEqual(latestUserMessageModel(history), {
    providerID: "openai",
    modelID: "gpt-5.6",
    variant: "high",
  });
});

test("normalization does not invent a variant", () => {
  assert.deepEqual(normalizePromptModel({ providerID: "openai", modelID: "gpt-5.6" }), {
    providerID: "openai",
    modelID: "gpt-5.6",
    variant: null,
  });
});

test("model initialization gate blocks send work until completed", async () => {
  const gate = createModelInitializationGate();
  let current = null;
  const synchronized = { providerID: "openai", modelID: "gpt-5.6", variant: "xhigh" };
  let resolved = false;
  const sendModel = awaitPromptModel(gate, null, () => current).then((model) => {
    resolved = true;
    return model;
  });

  await Promise.resolve();
  assert.equal(resolved, false);

  current = synchronized;
  gate.complete();
  assert.deepEqual(await sendModel, synchronized);
});

test("history polling advances current model and provides the value to persist", () => {
  const stale = { providerID: "openai", modelID: "gpt-5.5", variant: "low" };
  const result = reconcileHistoryModel(
    [userMessage(200, "openai", "gpt-5.6", "xhigh")],
    stale,
    100,
  );

  assert.deepEqual(result, {
    model: { providerID: "openai", modelID: "gpt-5.6", variant: "xhigh" },
    created: 200,
    messageID: null,
    changed: true,
  });
});

test("equal timestamps reconcile when the user message ids differ", () => {
  const current = { providerID: "openai", modelID: "gpt-5.5", variant: "low" };
  const next = userMessage(200, "openai", "gpt-5.6", "xhigh");
  next.info.id = "msg_new";

  assert.deepEqual(reconcileHistoryModel([next], current, 200, "msg_old"), {
    model: current,
    created: 200,
    messageID: "msg_old",
    changed: false,
  });
  assert.equal(needsAuthoritativeHistory([next], 200, "msg_old"), true);
  delete next.info.id;
  assert.equal(needsAuthoritativeHistory([next], 200, "msg_old"), true);
  next.info.id = "msg_new";
  assert.deepEqual(reconcileHistoryModel([next], current, 200, "msg_old", true), {
    model: { providerID: "openai", modelID: "gpt-5.6", variant: "xhigh" },
    created: 200,
    messageID: "msg_new",
    changed: true,
  });
});

test("history reconciliation clears a variant omitted by a newer user message", () => {
  const current = { providerID: "openai", modelID: "gpt-5.6", variant: "xhigh" };
  const next = userMessage(201, "openai", "gpt-5.6");
  next.info.id = "msg_no_variant";

  assert.deepEqual(reconcileHistoryModel([next], current, 200, "msg_with_variant"), {
    model: { providerID: "openai", modelID: "gpt-5.6", variant: null },
    created: 201,
    messageID: "msg_no_variant",
    changed: true,
  });
});

test("an explicit queued snapshot wins over later synchronized model changes", async () => {
  const gate = createModelInitializationGate();
  const selected = { providerID: "openai", modelID: "gpt-5.6", variant: "high" };
  const queued = { ...selected };
  selected.modelID = "later-selection";
  selected.variant = "low";
  gate.complete();

  assert.deepEqual(await awaitPromptModel(gate, queued, () => selected), {
    providerID: "openai",
    modelID: "gpt-5.6",
    variant: "high",
  });
});

test("history arriving during config initialization is reconciled after initialization", async () => {
  let initialized = false;
  let current = null;
  let releaseInitialization;
  const initialization = new Promise((resolve) => { releaseInitialization = resolve; });
  const history = [userMessage(300, "openai", "gpt-5.6", "high")];
  history[0].info.id = "msg_during_init";

  const reconciliation = reconcileModelAfterInitialization({
    history,
    isInitialized: () => initialized,
    initialize: async () => {
      await initialization;
      current = fallback;
      initialized = true;
    },
    getCurrent: () => current,
    getCursor: () => ({ created: -Infinity, messageID: null }),
    authoritative: true,
  });

  releaseInitialization();
  assert.deepEqual(await reconciliation, {
    model: { providerID: "openai", modelID: "gpt-5.6", variant: "high" },
    created: 300,
    messageID: "msg_during_init",
    changed: true,
  });
});

test("older equal-timestamp authoritative request cannot roll back a newer completion", async () => {
  const runLatest = createLatestRequestRunner();
  let resolveOlder;
  let resolveNewer;
  const older = new Promise((resolve) => { resolveOlder = resolve; });
  const newer = new Promise((resolve) => { resolveNewer = resolve; });
  const oldMessage = userMessage(400, "openai", "gpt-5.5", "low");
  oldMessage.info.id = "msg_old";
  const newMessage = userMessage(400, "openai", "gpt-5.6", "high");
  newMessage.info.id = "msg_new";
  let current = { providerID: "openai", modelID: "initial", variant: null };
  let cursor = { created: 399, messageID: "msg_initial" };
  const applyHistory = (history, isCurrent) => {
    if (!isCurrent()) return;
    const result = reconcileHistoryModel(history, current, cursor.created, cursor.messageID, true);
    if (!result.changed) return;
    current = result.model;
    cursor = { created: result.created, messageID: result.messageID };
  };

  const olderRequest = runLatest(() => older, applyHistory);
  const newerRequest = runLatest(() => newer, applyHistory);
  resolveNewer([oldMessage, newMessage]);
  resolveOlder([oldMessage]);

  assert.equal((await newerRequest).applied, true);
  assert.equal((await olderRequest).applied, false);
  assert.deepEqual(current, { providerID: "openai", modelID: "gpt-5.6", variant: "high" });
  assert.deepEqual(cursor, { created: 400, messageID: "msg_new" });
});
