import { config } from "./config.js";
import { unwrap, upstreamFetch, upstreamJson } from "./upstream.js";

// OpenCode 2.x session (GET /api/session/:id → data). `directory` is derived
// from `location.directory` so the rest of the server keeps its 1.x field name.
export type OpenCodeSession = {
  id: string;
  slug?: string;
  projectID: string;
  parentID?: string;
  directory: string;
  location?: { directory?: string };
  path?: string;
  title: string;
  agent?: string;
  model?: { id: string; providerID: string; variant?: string };
  time: { created: number; updated: number; idle?: number };
};

export function normalizeSession(raw: any): OpenCodeSession {
  const directory = raw?.directory ?? raw?.location?.directory ?? "";
  return { ...raw, directory, title: raw?.title ?? "" };
}

export const RECENT_SESSION_WINDOW_MS = 3 * 24 * 3600 * 1000;

export async function listSessions(): Promise<OpenCodeSession[]> {
  const list = await upstreamJson<any[]>("/session?limit=20&order=desc&parentID=null");
  return (Array.isArray(list) ? list : []).map(normalizeSession);
}

export async function listSessionPickerSessions(
  options: { sinceMs?: number; limit?: number } = {},
): Promise<OpenCodeSession[]> {
  // 2.x has no `start` filter; take the newest N and cut by time here.
  const params = new URLSearchParams({ limit: String(options.limit ?? 200), order: "desc", parentID: "null" });
  const list = (await upstreamJson<any[]>(`/session?${params}`)) ?? [];
  const sessions = (Array.isArray(list) ? list : []).map(normalizeSession);
  if (options.sinceMs === undefined) return sessions;
  return sessions.filter((session) => (session.time?.updated ?? 0) >= options.sinceMs!);
}

export async function getSession(id: string): Promise<OpenCodeSession | undefined> {
  const res = await upstreamFetch(`/session/${encodeURIComponent(id)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`OpenCode /session/${id} returned ${res.status}`);
  return normalizeSession(unwrap(await res.json()));
}

async function createSession(): Promise<OpenCodeSession> {
  return normalizeSession(await upstreamJson("/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "opencode-remote", location: { directory: config.opencodeDirectory } }),
  }));
}

function byUpdatedDesc(a: OpenCodeSession, b: OpenCodeSession): number {
  return b.time.updated - a.time.updated;
}

function normalizeDirectory(dir: string): string {
  const normalized = dir.replace(/[\\/]+/g, "\\").replace(/\\+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isConfiguredDirectory(session: OpenCodeSession): boolean {
  return normalizeDirectory(session.directory) === normalizeDirectory(config.opencodeDirectory);
}

export function isUserSession(session: OpenCodeSession): boolean {
  return !session.parentID;
}

export async function mergePinnedSessions(
  sessions: OpenCodeSession[],
  pinnedIds: readonly string[],
  loadSession: (id: string) => Promise<OpenCodeSession | undefined> = getSession,
): Promise<OpenCodeSession[]> {
  const pinnedSet = new Set(pinnedIds);
  const byId = new Map(sessions.filter(isUserSession).map((session) => [session.id, session]));
  const missingPinnedIds = [...pinnedSet].filter((id) => !byId.has(id)).slice(0, 20);
  const recovered = await Promise.all(missingPinnedIds.map(loadSession));

  for (const session of recovered) {
    if (session && isUserSession(session)) byId.set(session.id, session);
  }

  return [...byId.values()].sort((a, b) => {
    const pinOrder = Number(pinnedSet.has(b.id)) - Number(pinnedSet.has(a.id));
    return pinOrder || byUpdatedDesc(a, b);
  });
}

/**
 * 1.x SPA used base64url(directory) as the workspace slug; 2.x routes are
 * /session/<sessionId>. Kept exported for the tests that still cover it.
 */
export function encodeDirSlug(dir: string): string {
  const slugDirectory = dir.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  return Buffer.from(slugDirectory, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Finds the most recently updated session for OPENCODE_DIRECTORY,
 * falling back to the most recent session globally, creating one only
 * if no sessions exist at all.
 *
 * Returns the full SPA path: /<base64url(dir)>/session/<sessionId>
 * using the session directory as the slug to match OpenCode's workspace key.
 */
export async function resolveActiveSessionPath(): Promise<string> {
  const sessions = (await listSessions()).filter(isUserSession);

  const byDir = sessions
    .filter(isConfiguredDirectory)
    .sort(byUpdatedDesc);

  const session =
    byDir[0] ??
    [...sessions].sort(byUpdatedDesc)[0] ??
    (await createSession());

  // 2.x SPA routes are /<base64url(dir)>/session/<id> (same as the
  // /remote-sessions list links); bare /session/<id> renders
  // "Error: Unrecognised route!".
  const dir = session.directory || config.opencodeDirectory;
  return `/${encodeDirSlug(dir)}/session/${session.id}`;
}

export async function resolveActiveWorkspaceSessionPath(): Promise<string> {
  const sessions = (await listSessions()).filter(isUserSession);

  const byDir = sessions
    .filter(isConfiguredDirectory)
    .sort(byUpdatedDesc);

  void byDir;
  return "/";
}
