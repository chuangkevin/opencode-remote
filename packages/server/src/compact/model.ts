export type CompactPromptModel = {
  providerID: string;
  modelID: string;
  variant: string | null;
};

export type LatestUserModel = {
  model: CompactPromptModel;
  created: number;
  messageID: string | null;
};

export class LatestUserModelBudgetError extends Error {}
export class LatestUserModelUpstreamError extends Error {}

export function latestUserModelInPage(messages: unknown[]): LatestUserModel | null {
  let latest: LatestUserModel | null = null;
  for (const message of messages as any[]) {
    const info = message?.info ?? {};
    if (info.role !== "user") continue;
    const providerID = typeof info.model?.providerID === "string" ? info.model.providerID : "";
    const rawModelID = info.model?.modelID ?? info.model?.id;
    const modelID = typeof rawModelID === "string" ? rawModelID : "";
    if (!providerID || !modelID) continue;
    const created = Number(info.time?.created ?? 0);
    if (latest && created < latest.created) continue;
    const variant = info.variant ?? info.model?.variant;
    latest = {
      model: {
        providerID,
        modelID,
        variant: typeof variant === "string" && variant ? variant : null,
      },
      created,
      messageID: typeof info.id === "string" && info.id ? info.id : null,
    };
  }
  return latest;
}

type FindLatestUserModelOptions = {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

// OpenCode 2.x keeps the session's current model on the session itself
// (GET /api/session/:id → data.model = { id, providerID, variant }), so there
// is no message-history scan any more.
export async function findLatestUserModel(
  upstream: string,
  sessionID: string,
  options: FindLatestUserModelOptions = {},
): Promise<LatestUserModel | { model: null }> {
  const fetchPage = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchPage(`${upstream}/api/session/${sessionID}`, { signal: options.signal, headers: options.headers });
  } catch (err) {
    if (options.signal?.aborted) throw err;
    throw new LatestUserModelUpstreamError(err instanceof Error ? err.message : "upstream request failed");
  }
  if (!response.ok) throw new LatestUserModelUpstreamError(`upstream session ${response.status}`);
  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new LatestUserModelUpstreamError("upstream session response is not JSON");
  }
  const session = payload && typeof payload === "object" && "data" in payload ? payload.data : payload;
  const model = session?.model;
  const providerID = typeof model?.providerID === "string" ? model.providerID : "";
  const modelID = typeof model?.id === "string" ? model.id : typeof model?.modelID === "string" ? model.modelID : "";
  if (!providerID || !modelID) return { model: null };
  const variant = typeof model?.variant === "string" && model.variant && model.variant !== "default" ? model.variant : null;
  return {
    model: { providerID, modelID, variant },
    created: Number(session?.time?.updated ?? 0),
    messageID: null,
  };
}
