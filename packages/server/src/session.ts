import { config } from "./config.js";

type OpenCodeSession = {
  id: string;
  slug: string;
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

/**
 * Finds the most recently updated session whose directory matches
 * OPENCODE_DIRECTORY. Creates a new session if none found.
 * Returns the session slug (used in the URL /<slug>).
 */
export async function resolveActiveSlug(): Promise<string> {
  const sessions = await listSessions();
  const matching = sessions
    .filter((s) => s.directory === config.opencodeDirectory)
    .sort((a, b) => b.time.updated - a.time.updated);

  if (matching.length > 0) {
    return matching[0].slug;
  }

  const created = await createSession();
  return created.slug;
}
