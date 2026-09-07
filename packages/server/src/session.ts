import { config } from "./config.js";

export type OpenCodeSession = {
  id: string;
  slug: string;
  projectID: string;
  parentID?: string;
  directory: string;
  path?: string;
  title: string;
  time: { created: number; updated: number };
};

export async function listSessions(): Promise<OpenCodeSession[]> {
  const res = await fetch(`${config.opencodeUrl}/session`);
  if (!res.ok) throw new Error(`OpenCode /session returned ${res.status}`);
  return res.json() as Promise<OpenCodeSession[]>;
}

export async function listSessionPickerSessions(): Promise<OpenCodeSession[]> {
  const url = new URL(`${config.opencodeUrl}/session`);
  url.searchParams.set("roots", "true");
  url.searchParams.set("limit", "1000");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OpenCode /session returned ${res.status}`);
  return res.json() as Promise<OpenCodeSession[]>;
}

export async function getSession(id: string): Promise<OpenCodeSession | undefined> {
  const res = await fetch(`${config.opencodeUrl}/session/${encodeURIComponent(id)}`);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`OpenCode /session/${id} returned ${res.status}`);
  return res.json() as Promise<OpenCodeSession>;
}

async function createSession(): Promise<OpenCodeSession> {
  const res = await fetch(`${config.opencodeUrl}/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "opencode-remote" }),
  });
  if (!res.ok) throw new Error(`OpenCode POST /session returned ${res.status}`);
  return res.json() as Promise<OpenCodeSession>;
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
  const missingPinnedIds = [...pinnedSet].filter((id) => !byId.has(id));
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
 * OpenCode's SPA uses base64url(directory) as the workspace slug in the URL:
 *   /<base64url(directory)>/session/<sessionId>
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

  const dirSlug = encodeDirSlug(session.directory);
  return `/${dirSlug}/session/${session.id}`;
}

export async function resolveActiveWorkspaceSessionPath(): Promise<string> {
  const sessions = (await listSessions()).filter(isUserSession);

  const byDir = sessions
    .filter(isConfiguredDirectory)
    .sort(byUpdatedDesc);

  const session = byDir[0] ?? [...sessions].sort(byUpdatedDesc)[0];
  const directory = session?.directory ?? config.opencodeDirectory;
  return `/${encodeDirSlug(directory)}/session`;
}
