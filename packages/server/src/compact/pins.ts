// File-backed pin store for compact UI.
//
// OpenCode upstream has no per-session pin concept — its `pin`/`unpin` calls
// in the native SPA bundle are an internal cache for which directories the
// sidebar keeps mounted. We own this state ourselves.
//
// Storage layout:
//   <OPENCODE_DIRECTORY>/.opencode-remote/pins.json
//   { "pinned": ["ses_xxx", "ses_yyy"] }
//
// Order of the array reflects pin time (oldest first). Callers that want
// "most recently pinned first" should reverse on read.

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { config as appConfig } from "../config.js";

const PINS_DIR = join(appConfig.opencodeDirectory, ".opencode-remote");
const PINS_FILE = join(PINS_DIR, "pins.json");

interface PinsFile {
  pinned: string[];
}

// In-memory mirror of the on-disk file. Refreshed lazily on first read,
// then kept in sync by the write helpers. Concurrent writers would race
// here — the proxy is single-process so we don't bother locking.
let cache: Set<string> | null = null;

async function readPinsFromDisk(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(PINS_FILE, "utf8");
    const data = JSON.parse(raw) as Partial<PinsFile>;
    const ids = Array.isArray(data?.pinned)
      ? data.pinned.filter((x): x is string => typeof x === "string" && x.startsWith("ses_"))
      : [];
    return new Set(ids);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn("[opencode-remote] reading pins.json failed:", err);
    }
    return new Set();
  }
}

async function ensureCache(): Promise<Set<string>> {
  if (!cache) cache = await readPinsFromDisk();
  return cache;
}

async function writePinsToDisk(pinned: Set<string>): Promise<void> {
  await fs.mkdir(PINS_DIR, { recursive: true });
  const data: PinsFile = { pinned: Array.from(pinned) };
  const tmp = PINS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, PINS_FILE);
}

export async function listPins(): Promise<string[]> {
  const set = await ensureCache();
  return Array.from(set);
}

export async function isPinned(id: string): Promise<boolean> {
  const set = await ensureCache();
  return set.has(id);
}

export async function pinSession(id: string): Promise<void> {
  if (!/^ses_[A-Za-z0-9]+$/.test(id)) throw new Error(`invalid session id: ${id}`);
  const set = await ensureCache();
  if (set.has(id)) return;
  set.add(id);
  await writePinsToDisk(set);
}

export async function unpinSession(id: string): Promise<void> {
  const set = await ensureCache();
  if (!set.has(id)) return;
  set.delete(id);
  await writePinsToDisk(set);
}
