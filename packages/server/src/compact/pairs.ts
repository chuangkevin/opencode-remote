// Pair-partner session dashboard backend.
//
// Claude delegates work to OpenCode partner sessions whose titles are always
//   pair·<owner Claude session>·<task>   (U+00B7 MIDDLE DOT separators)
// This module owns: title parsing, the accept store (mirrors pins.ts layout),
// and assembling GET /api/pairs payloads.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { config as appConfig } from "../config.js";
import { unwrap, upstreamFetch, upstreamJson } from "../upstream.js";
import { normalizeSession } from "../session.js";

export const PAIR_TITLE_PREFIX = "pair·";
const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

export function parsePairTitle(title: string): { owner: string; task: string } | undefined {
  if (!title.startsWith(PAIR_TITLE_PREFIX)) return undefined;
  const parts = title.split("·");
  // ["pair", owner, ...task]
  if (parts.length < 3 || !parts[1]) return undefined;
  const task = parts.slice(2).join("·");
  if (!task) return undefined;
  return { owner: parts[1], task };
}

export function isPairSession(session: { title?: unknown }): boolean {
  return typeof session?.title === "string" && parsePairTitle(session.title) !== undefined;
}

export function assertSessionID(id: string): void {
  if (!SESSION_ID_RE.test(id)) throw new Error(`invalid session id: ${id}`);
}

// ── Accept store ─────────────────────────────────────────────────────────────
// <OPENCODE_DIRECTORY>/.opencode-remote/pairs-accept.json
//   { "accepted": { "<ses_id>": <acceptedAt ms> } }

const ACCEPT_DIR = join(appConfig.opencodeDirectory, ".opencode-remote");
const ACCEPT_FILE = join(ACCEPT_DIR, "pairs-accept.json");

let acceptDirOverride: string | null = null;
/** Test hook: redirect the store into a temp dir. */
export function _setPairsStoreDir(dir: string | null): void {
  acceptDirOverride = dir;
  acceptCache = null;
}

function acceptFile(): string {
  return acceptDirOverride ? join(acceptDirOverride, "pairs-accept.json") : ACCEPT_FILE;
}

function acceptDir(): string {
  return acceptDirOverride ?? ACCEPT_DIR;
}

let acceptCache: Map<string, number> | null = null;

async function readAcceptFromDisk(): Promise<Map<string, number>> {
  try {
    const raw = await fs.readFile(acceptFile(), "utf8");
    const data = JSON.parse(raw) as { accepted?: Record<string, unknown> };
    const out = new Map<string, number>();
    if (data?.accepted && typeof data.accepted === "object") {
      for (const [id, at] of Object.entries(data.accepted)) {
        if (SESSION_ID_RE.test(id) && Number.isSafeInteger(at)) out.set(id, at as number);
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[opencode-remote] reading pairs-accept.json failed:", err);
    }
    return new Map();
  }
}

async function ensureAcceptCache(): Promise<Map<string, number>> {
  if (!acceptCache) acceptCache = await readAcceptFromDisk();
  return acceptCache;
}

async function writeAcceptToDisk(map: Map<string, number>): Promise<void> {
  await fs.mkdir(acceptDir(), { recursive: true });
  const accepted: Record<string, number> = {};
  for (const [id, at] of map) accepted[id] = at;
  const tmp = acceptFile() + ".tmp";
  await fs.writeFile(tmp, JSON.stringify({ accepted }, null, 2), "utf8");
  await fs.rename(tmp, acceptFile());
}

export async function getAcceptedAt(id: string): Promise<number | undefined> {
  return (await ensureAcceptCache()).get(id);
}

export async function listAccepted(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [id, at] of await ensureAcceptCache()) out[id] = at;
  return out;
}

export async function acceptPair(id: string, now = Date.now()): Promise<number> {
  assertSessionID(id);
  const map = await ensureAcceptCache();
  map.set(id, now);
  await writeAcceptToDisk(map);
  return now;
}

export async function unacceptPair(id: string): Promise<void> {
  assertSessionID(id);
  const map = await ensureAcceptCache();
  if (!map.has(id)) return;
  map.delete(id);
  await writeAcceptToDisk(map);
}

// ── Pair list assembly ───────────────────────────────────────────────────────

export type PairStatus = "busy" | "idle" | "ask" | "error";

export type PairModel = {
  provider: string;
  id: string;
  variant?: string;
};

export type PairSessionLite = {
  id: string;
  title: string;
  model?: { providerID?: string; id?: string; modelID?: string; variant?: string };
};

export type ChatMessage = {
  type?: string;
  info?: {
    role?: string;
    error?: { type?: string; message?: string } | null;
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    } | null;
    time?: { created?: number; streamed?: number; completed?: number };
  };
  // 2.x message endpoints return the same fields at top level (no info wrapper).
  error?: { type?: string; message?: string } | null;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  } | null;
  time?: { created?: number; streamed?: number; completed?: number };
  content?: Array<{ type?: string; text?: string }>;
};

export type PairInfo = {
  id: string;
  partner: "pi" | "opencode";
  owner: string;
  task: string;
  status: PairStatus;
  lastActivityAt: number;
  contextPct: number | null;
  lastText: string;
  model?: PairModel;
  acceptedAt?: number;
  url: string;
};

function messageArray(payload: unknown): ChatMessage[] {
  const data = unwrap<any>(payload);
  return Array.isArray(data) ? data as ChatMessage[] : [];
}

function messageTime(m: ChatMessage): number {
  const t = m.info?.time ?? m.time;
  return Math.max(Number(t?.created ?? 0), Number(t?.completed ?? 0));
}

function messageTokens(m: ChatMessage): ChatMessage["tokens"] {
  return m.info?.tokens ?? m.tokens ?? null;
}

function messageError(m: ChatMessage): ChatMessage["error"] {
  return m.info?.error ?? m.error;
}

function assistantMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.type === "assistant");
}

function messageText(m: ChatMessage): string {
  if (!Array.isArray(m.content)) return "";
  return m.content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

export function computePairInfo(
  session: PairSessionLite,
  ctx: {
    busy: boolean;
    formPending: boolean;
    messages: ChatMessage[];
    contextLimit?: number;
    acceptedAt?: number;
  },
): PairInfo {
  const parsed = parsePairTitle(session.title) ?? { owner: "", task: "" };
  const assistants = assistantMessages(ctx.messages);
  const newestAssistant = assistants[0];

  let status: PairStatus = "idle";
  if (ctx.busy) status = "busy";
  else if (ctx.formPending) status = "ask";
  else if (newestAssistant && messageError(newestAssistant)) status = "error";

  let lastActivityAt = 0;
  for (const m of ctx.messages) lastActivityAt = Math.max(lastActivityAt, messageTime(m));

  let contextPct: number | null = null;
  if (ctx.contextLimit && ctx.contextLimit > 0) {
    const withTokens = assistants.find((m) => messageTokens(m));
    const tokens = withTokens ? messageTokens(withTokens) : null;
    if (tokens) {
      const t = tokens;
      const used = Number(t.input ?? 0) + Number(t.cache?.read ?? 0);
      contextPct = Math.round((used / ctx.contextLimit) * 1000) / 10;
    }
  }

  const withText = assistants.find((m) => messageText(m).length > 0);
  const lastText = withText ? messageText(withText).slice(-200) : "";

  const modelID = session.model?.modelID ?? session.model?.id;
  const modelProvider = session.model?.providerID;
  const modelVariant = (session.model as { variant?: unknown })?.variant;
  const info: PairInfo = {
    id: session.id,
    partner: "opencode",
    owner: parsed.owner,
    task: parsed.task,
    status,
    lastActivityAt,
    contextPct,
    lastText,
    url: `/c/session/${session.id}`,
  };
  if (typeof modelID === "string" && modelID) {
    const model: PairModel = {
      provider: typeof modelProvider === "string" ? modelProvider : "",
      id: modelID,
    };
    if (typeof modelVariant === "string" && modelVariant) model.variant = modelVariant;
    info.model = model;
  }
  if (ctx.acceptedAt !== undefined) info.acceptedAt = ctx.acceptedAt;
  return info;
}

export type PairsDeps = {
  listPairSessions?: () => Promise<PairSessionLite[]>;
  fetchBusySet?: () => Promise<Set<string>>;
  fetchForm?: (id: string) => Promise<unknown[]>;
  fetchMessages?: (id: string) => Promise<ChatMessage[]>;
  fetchContextLimit?: (providerID: string, modelID: string) => Promise<number | undefined>;
  acceptedMap?: () => Promise<Record<string, number>>;
  messageLimit?: number;
};

async function defaultListPairSessions(): Promise<PairSessionLite[]> {
  const list = await upstreamJson<any[]>(`/session?limit=200&order=desc&parentID=null`);
  return (Array.isArray(list) ? list : [])
    .map((raw) => normalizeSession(raw))
    .filter((s) => isPairSession(s))
    .map((s) => ({ id: s.id, title: s.title, model: s.model as PairSessionLite["model"] }));
}

async function defaultFetchBusySet(): Promise<Set<string>> {
  const res = await upstreamFetch("/session/active");
  if (!res.ok) return new Set();
  const active = unwrap<Record<string, { type?: string }>>(await res.json());
  const out = new Set<string>();
  if (active && typeof active === "object") {
    for (const [id, st] of Object.entries(active)) {
      if (st?.type === "running" || st?.type === "busy") out.add(id);
    }
  }
  return out;
}

async function defaultFetchForm(id: string): Promise<unknown[]> {
  try {
    const res = await upstreamFetch(`/session/${encodeURIComponent(id)}/form`);
    if (!res.ok) return [];
    const data = unwrap<unknown>(await res.json());
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function defaultFetchMessages(id: string, limit: number): Promise<ChatMessage[]> {
  const res = await upstreamFetch(`/session/${encodeURIComponent(id)}/message?limit=${limit}`);
  if (!res.ok) throw new Error(`GET /api/session/${id}/message returned ${res.status}`);
  return messageArray(await res.json());
}

const modelLimitCache = new Map<string, number | undefined>();

async function defaultFetchContextLimit(providerID: string, modelID: string): Promise<number | undefined> {
  const key = `${providerID}/${modelID}`;
  if (modelLimitCache.has(key)) return modelLimitCache.get(key);
  try {
    const models = await upstreamJson<any[]>(`/model?location[directory]=${encodeURIComponent(appConfig.opencodeDirectory)}`);
    for (const m of Array.isArray(models) ? models : []) {
      const pid = m?.providerID;
      const mid = m?.modelID ?? m?.id;
      if (pid === providerID && mid === modelID) {
        const limit = Number(m?.limit?.context);
        const value = Number.isFinite(limit) && limit > 0 ? limit : undefined;
        modelLimitCache.set(key, value);
        return value;
      }
    }
    modelLimitCache.set(key, undefined);
    return undefined;
  } catch {
    return undefined;
  }
}

export async function buildPairsList(deps: PairsDeps = {}): Promise<PairInfo[]> {
  const sessions = await (deps.listPairSessions ?? defaultListPairSessions)();
  const messageLimit = deps.messageLimit ?? 40;
  const [busySet, accepted] = await Promise.all([
    (deps.fetchBusySet ?? defaultFetchBusySet)().catch(() => new Set<string>()),
    (deps.acceptedMap ?? listAccepted)().catch(() => ({} as Record<string, number>)),
  ]);

  const fetchForm = deps.fetchForm ?? defaultFetchForm;
  const fetchMessages = deps.fetchMessages ?? ((id: string) => defaultFetchMessages(id, messageLimit));
  const fetchContextLimit = deps.fetchContextLimit ?? defaultFetchContextLimit;

  const settled = await Promise.allSettled(
    sessions.map(async (session): Promise<PairInfo> => {
      const [formResult, messagesResult] = await Promise.allSettled([
        fetchForm(session.id),
        fetchMessages(session.id),
      ]);
      const form = formResult.status === "fulfilled" ? formResult.value : [];
      const messages = messagesResult.status === "fulfilled" ? messagesResult.value : [];
      let contextLimit: number | undefined;
      const providerID = session.model?.providerID;
      const modelID = session.model?.modelID ?? session.model?.id;
      if (providerID && modelID) {
        contextLimit = await fetchContextLimit(providerID, modelID).catch(() => undefined);
      }
      return computePairInfo(session, {
        busy: busySet.has(session.id),
        formPending: form.length > 0,
        messages,
        contextLimit,
        acceptedAt: accepted[session.id],
      });
    }),
  );

  const pairs: PairInfo[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled") pairs.push(r.value);
  }
  // Newest activity first.
  pairs.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return pairs;
}
