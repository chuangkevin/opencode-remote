import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parsePairTitle, type PairInfo } from "./pairs.js";

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;
const DEFAULT_REGISTRY_PATH = join(homedir(), ".local", "state", "pi-pairs", "registry.json");

let registryPathOverride: string | null = null;

/** Test hook: redirect the Pi registry into a temp file. */
export function _setPiPairsRegistryPath(path: string | null): void {
  registryPathOverride = path;
}

function registryPath(): string {
  return registryPathOverride ?? DEFAULT_REGISTRY_PATH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toPairInfo(value: unknown): PairInfo | undefined {
  if (!isRecord(value)) return undefined;

  const id = value.id;
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return undefined;

  const title = typeof value.title === "string" ? value.title : undefined;
  const parsedTitle = title ? parsePairTitle(title) : undefined;
  const owner = typeof value.owner === "string" && value.owner ? value.owner : parsedTitle?.owner;
  const task = typeof value.task === "string" && value.task ? value.task : parsedTitle?.task;
  if (!owner || !task) return undefined;

  const status = value.status;
  if (status !== "busy" && status !== "idle" && status !== "error") return undefined;

  const lastActivityAt = value.lastActivityAt;
  if (typeof lastActivityAt !== "number" || !Number.isFinite(lastActivityAt)) return undefined;

  const lastText = value.lastText;
  if (typeof lastText !== "string") return undefined;

  const model = value.model;
  if (!isRecord(model) || typeof model.provider !== "string" || !model.provider || typeof model.id !== "string" || !model.id) {
    return undefined;
  }

  return {
    id,
    partner: "pi",
    owner,
    task,
    status,
    lastActivityAt,
    contextPct: null,
    lastText,
    model: { provider: model.provider, id: model.id },
    url: "#",
  };
}

export async function listPiPairs(): Promise<PairInfo[]> {
  const path = registryPath();
  if (!existsSync(path)) return [];

  try {
    const raw = await fs.readFile(path, "utf8");
    const registry: unknown = JSON.parse(raw);
    if (!isRecord(registry) || !isRecord(registry.sessions)) return [];

    const pairs: PairInfo[] = [];
    for (const session of Object.values(registry.sessions)) {
      const pair = toPairInfo(session);
      if (pair) pairs.push(pair);
    }
    return pairs;
  } catch {
    return [];
  }
}
