// Shared trust-mode permission ruleset for the compact UI.
// Kept in sync with the JS copy in packages/server/static/compact.js
// (TRUST_PERMISSION_ARRAY) — server-side PATCH and client-side toggle
// both read from this single source.

export type PermissionRule = {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
};

// Allow most things, keep destructive / secrets denied.
// Mirrors opencode.json's permission policy, flipping "ask" → "allow".
export const TRUST_PERMISSION_ARRAY: PermissionRule[] = [
  // edit: allow * (secrets stay deny)
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "edit", pattern: ".env", action: "deny" },
  { permission: "edit", pattern: ".env.*", action: "deny" },
  { permission: "edit", pattern: "*service-account*.json", action: "deny" },
  { permission: "edit", pattern: "*credential*.json", action: "deny" },
  { permission: "edit", pattern: "secrets/**", action: "deny" },
  { permission: "edit", pattern: ".claude-memory/**", action: "deny" },
  { permission: "edit", pattern: "**/.env", action: "deny" },
  { permission: "edit", pattern: "**/.env.*", action: "deny" },
  { permission: "edit", pattern: "**/*service-account*.json", action: "deny" },
  { permission: "edit", pattern: "**/*credential*.json", action: "deny" },
  { permission: "edit", pattern: "**/secrets/**", action: "deny" },
  { permission: "edit", pattern: "**/.claude-memory/**", action: "deny" },
  // bash: allow * (destructive stay deny)
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "git reset --hard*", action: "deny" },
  { permission: "bash", pattern: "git push --force*", action: "deny" },
  { permission: "bash", pattern: "git clean*", action: "deny" },
  { permission: "bash", pattern: "Remove-Item *", action: "deny" },
  { permission: "bash", pattern: "del *", action: "deny" },
  { permission: "bash", pattern: "rmdir *", action: "deny" },
  { permission: "bash", pattern: "* > .env*", action: "deny" },
  // git_git_*: keep destructive deny, allow the rest
  { permission: "git_git_reset", pattern: "*", action: "deny" },
  { permission: "git_git_clean", pattern: "*", action: "deny" },
  { permission: "git_git_clear_working_dir", pattern: "*", action: "deny" },
  { permission: "git_git_push", pattern: "*", action: "allow" },
  { permission: "git_git_commit", pattern: "*", action: "allow" },
  // MCP wildcards: allow all
  { permission: "github_*", pattern: "*", action: "allow" },
  { permission: "filesystem_*", pattern: "*", action: "allow" },
  { permission: "fetch_*", pattern: "*", action: "allow" },
];

// PATCH the given session with the trust ruleset. Idempotent in the sense
// that PATCHing twice produces the same effective behavior (last-wins).
// OpenCode v1.14.30's PATCH is append-only — the array grows on each call.
// We accept that for now; the alternative requires a server fix.
export async function ensureSessionTrust(opencodeUrl: string, sessionID: string): Promise<void> {
  const r = await fetch(`${opencodeUrl}/session/${sessionID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ permission: TRUST_PERMISSION_ARRAY }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`PATCH /session/${sessionID} returned ${r.status}: ${body.slice(0, 200)}`);
  }
}
