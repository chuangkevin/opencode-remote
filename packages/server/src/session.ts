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
 * OpenCode's SPA uses base64url(directory) as the workspace slug in the URL:
 *   /<base64url(directory)>/session/<sessionId>
 */
function encodeDirSlug(dir: string): string {
  return Buffer.from(dir, "utf8")
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
 * using the CONFIGURED directory as the slug (avoids corrupted stored paths).
 */
export async function resolveActiveSessionPath(): Promise<string> {
  const sessions = await listSessions();

  const byDir = sessions
    .filter((s) => s.directory === config.opencodeDirectory)
    .sort(byUpdatedDesc);

  const session =
    byDir[0] ??
    [...sessions].sort(byUpdatedDesc)[0] ??
    (await createSession());

  const dirSlug = encodeDirSlug(session.directory);
  return `/${dirSlug}/session/${session.id}`;
}
