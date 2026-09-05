export function normalizePromptModel(model) {
  const providerID = typeof model?.providerID === "string" ? model.providerID : "";
  const rawModelID = model?.modelID ?? model?.id;
  const modelID = typeof rawModelID === "string" ? rawModelID : "";
  if (!providerID || !modelID) return null;
  return {
    providerID,
    modelID,
    variant: typeof model?.variant === "string" && model.variant ? model.variant : null,
  };
}

export function latestUserMessageSelection(messages) {
  let latest = null;
  let latestCreated = -Infinity;
  let latestMessageID = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    const info = message?.info ?? {};
    if (info.role !== "user") continue;
    const model = normalizePromptModel({
      ...info.model,
      variant: info.variant ?? info.model?.variant,
    });
    if (!model) continue;
    const created = Number(info.time?.created ?? 0);
    if (created >= latestCreated) {
      latest = model;
      latestCreated = created;
      latestMessageID = typeof info.id === "string" && info.id ? info.id : null;
    }
  }
  return latest ? { model: latest, created: latestCreated, messageID: latestMessageID } : null;
}

export function latestUserMessageModel(messages) {
  return latestUserMessageSelection(messages)?.model ?? null;
}

export function chooseInitialModel({ history, saved, configured, fallback }) {
  const historyModel = latestUserMessageModel(history);
  const choices = [
    [historyModel, "history"],
    [normalizePromptModel(saved), "saved"],
    [normalizePromptModel(configured), "config"],
    [normalizePromptModel(fallback), "fallback"],
  ];
  for (const [model, source] of choices) {
    if (model) return { model, source };
  }
  throw new Error("No valid compact model fallback");
}

export function reconcileHistoryModel(
  messages,
  current,
  lastCreated = -Infinity,
  lastMessageID = null,
  authoritative = false,
) {
  const latest = latestUserMessageSelection(messages);
  const normalizedCurrent = normalizePromptModel(current);
  const sameKnownMessage = latest?.messageID && lastMessageID && latest.messageID === lastMessageID;
  const ambiguousEqualMessage = latest?.created === lastCreated && !sameKnownMessage;
  const sameUnidentifiedModel = latest?.created === lastCreated && !latest?.messageID && !lastMessageID &&
    latest.model.providerID === normalizedCurrent?.providerID &&
    latest.model.modelID === normalizedCurrent?.modelID &&
    latest.model.variant === normalizedCurrent?.variant;
  if (
    !latest ||
    latest.created < lastCreated ||
    sameKnownMessage ||
    sameUnidentifiedModel ||
    (ambiguousEqualMessage && !authoritative)
  ) {
    return {
      model: normalizedCurrent,
      created: lastCreated,
      messageID: lastMessageID,
      changed: false,
    };
  }
  return { ...latest, changed: true };
}

function snapshotPromptModel(model) {
  const normalized = normalizePromptModel(model);
  return normalized ? { ...normalized } : null;
}

export async function awaitPromptModel(gate, snapshot, getCurrent) {
  await gate.ready;
  return snapshotPromptModel(snapshot) ?? snapshotPromptModel(getCurrent());
}

export function needsAuthoritativeHistory(messages, lastCreated, lastMessageID) {
  const latest = latestUserMessageSelection(messages);
  if (!latest || latest.created !== lastCreated) return false;
  return !latest.messageID || !lastMessageID || latest.messageID !== lastMessageID;
}

export async function reconcileModelAfterInitialization({
  history,
  isInitialized,
  initialize,
  getCurrent,
  getCursor,
  authoritative = false,
}) {
  if (!isInitialized()) {
    if (!latestUserMessageSelection(history)) return null;
    await initialize(history);
  }
  if (!isInitialized()) return null;
  const cursor = getCursor();
  return reconcileHistoryModel(
    history,
    getCurrent(),
    cursor.created,
    cursor.messageID,
    authoritative,
  );
}

export function createLatestRequestRunner() {
  let latestStarted = 0;
  return async function runLatest(load, apply) {
    const request = ++latestStarted;
    const value = await load();
    if (request !== latestStarted) return { value, applied: false };
    const isCurrent = () => request === latestStarted;
    await apply(value, isCurrent);
    return { value, applied: isCurrent() };
  };
}

export function createModelInitializationGate() {
  let complete;
  const ready = new Promise((resolve) => { complete = resolve; });
  let completed = false;
  return {
    ready,
    complete() {
      if (completed) return;
      completed = true;
      complete();
    },
  };
}
