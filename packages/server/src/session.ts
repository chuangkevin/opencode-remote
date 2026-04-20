import { config } from "./config.js";

type OpenCodeSession = {
  id: string;
  slug: string;
  projectID: string;
  directory: string;
  title: string;
  time: { created: number; updated: number };
};

async function listSessions(): Promise<OpenCodeSession[]> {
  const res = await fetch(`${config.opencodeUrl}/session`);
  if (!res.ok) throw new Error(`OpenCode /session returned ${res.status}`);
  return res.json() as Promise<OpenCodeSession[]>;
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

/**
 * Finds the most recently updated session whose directory matches
 * OPENCODE_DIRECTORY, falling back to the globally most recent session,
 * and creating one only when no sessions exist at all.
 * Returns the full SPA path: /<projectID>/session/<sessionID>
 */
export async function resolveActiveSessionPath(): Promise<string> {
  const sessions = await listSessions();

  const byDir = sessions
    .filter((s) => s.directory === config.opencodeDirectory)
    .sort(byUpdatedDesc);

  const session =
    byDir[0] ??
    sessions.sort(byUpdatedDesc)[0] ??
    (await createSession());

  return `/${session.projectID}/session/${session.id}`;
}
