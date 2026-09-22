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

// OpenCode 2.x: permissions are governed by the global opencode.jsonc
// `permissions` rules (Kevin's config already allows shell/edit/external_directory),
// and the 1.x per-session `permission` PATCH no longer exists. Kept as a no-op so
// the call sites stay put; the ruleset above is still mirrored by compact.js.
export async function ensureSessionTrust(_opencodeUrl: string, _sessionID: string): Promise<void> {
  return;
}
