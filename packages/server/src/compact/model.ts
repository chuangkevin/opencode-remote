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

function latestUserModelInPage(messages: unknown[]): LatestUserModel | null {
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
  maxPages?: number;
  pageSize?: number;
};

export async function findLatestUserModel(
  upstream: string,
  sessionID: string,
  options: FindLatestUserModelOptions = {},
): Promise<LatestUserModel | { model: null }> {
  const fetchPage = options.fetch ?? fetch;
  const maxPages = options.maxPages ?? 100;
  const pageSize = options.pageSize ?? 30;
  const seenCursors = new Set<string>();
  let before: string | null = null;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${upstream}/session/${sessionID}/message`);
    url.searchParams.set("limit", String(pageSize));
    if (before) url.searchParams.set("before", before);

    let response: Response;
    try {
      response = await fetchPage(url, { signal: options.signal });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      throw new LatestUserModelUpstreamError(err instanceof Error ? err.message : "upstream request failed");
    }
    if (!response.ok) throw new LatestUserModelUpstreamError(`upstream messages ${response.status}`);

    let messages: unknown;
    try {
      messages = await response.json();
    } catch {
      throw new LatestUserModelUpstreamError("upstream messages response is not JSON");
    }
    if (!Array.isArray(messages)) {
      throw new LatestUserModelUpstreamError("upstream messages response is not an array");
    }

    const latest = latestUserModelInPage(messages);
    if (latest) return latest;

    const nextCursor = response.headers.get("x-next-cursor");
    if (!nextCursor) return { model: null };
    if (seenCursors.has(nextCursor)) {
      throw new LatestUserModelBudgetError("upstream repeated the model-history cursor");
    }
    seenCursors.add(nextCursor);
    before = nextCursor;
  }

  throw new LatestUserModelBudgetError(`model-history scan exceeded ${maxPages} pages`);
}
