# opencode-remote Workspace Rules

This file is loaded by opencode running the GPT-5.5 backend. It is the concise
workspace rule entrypoint for HomeProject opencode sessions.

## Runtime Identity

- Runtime: opencode with GPT-5.5.
- Commit co-author line for opencode-authored commits:
  `Co-Authored-By: Kevin-AI <kevin950805@gmail.com>`.
- Do not use Claude-specific co-author lines for opencode work.

## Workspace Root

- Treat `OPENCODE_DIRECTORY` as `<HOMEPROJECT_ROOT>`.
- Supported roots include `D:\Projects\_HomeProject` and `D:\GitClone\_HomeProject`.
- Do not hard-code one root as the only valid location in new docs or config.

## Rule Sources

The broader HomeProject rule source is `homelab-docs/CLAUDE.md`. Read it when a
task depends on HomeProject infrastructure, deployment, ports, DNS, Caddy,
Tailscale, user preferences, or shared project standards.

Load skill files lazily based on task type instead of pulling every skill into
context by default:

- Normal implementation: `homelab-docs/skills/execution-style/SKILL.md`
- Completion after code/spec changes: `homelab-docs/skills/completion-checklist/SKILL.md`
- New features or major changes: `homelab-docs/skills/plan-before-build/SKILL.md`
- Agent architecture: `homelab-docs/skills/agent-design/SKILL.md`
- External APIs, AI calls, retries: `homelab-docs/skills/integration-robustness/SKILL.md`
- Runtime, CI, deployment status: `homelab-docs/skills/verification-and-evidence/SKILL.md`
- Bugs and regressions: `homelab-docs/skills/root-cause-debugging/SKILL.md`
- Deployment, Docker, Caddy, tunnels: `homelab-docs/skills/deployment/SKILL.md`

## Memory

opencode memory lives in `opencode-remote/.opencode-memory/`.

- Read `opencode-remote/.opencode-memory/MEMORY.md` before answering remembered
  preference or decision questions.
- Write/update memory only when the user gives durable preferences,
  corrections, project facts, or reference facts that should affect future
  sessions.
- Do not write memory for facts that are easily re-read from code, git, or docs.
- Memory is a hint; re-verify live code/runtime claims.

## MCP Usage

- Use filesystem MCP for structured workspace file reads when helpful.
- Use git MCP for read-oriented repository inspection; destructive git MCP tools
  are denied by config.
- Use GitHub MCP only when GitHub API access is actually needed.
- Use fetch MCP for URL to markdown/text retrieval.
- Playwright MCP is present but disabled by default.

## Subagents

Subagent definitions live in `opencode-remote/.opencode/agents/` after Task 4
of the capability-alignment plan is implemented and workspace wiring exposes
them to OpenCode. Intended usage once available:

- `explore`: read-only codebase or git research.
- `plan`: read-only planning and spec synthesis.
- `implement`: bounded implementation work with strict permissions.
- `verify`: no-edit test/build/smoke verification.
- `reviewer`: read-only diff and code review.

## Worktree Rule

Use worktree isolation for cross-repo changes, changes touching three or more
files, high-risk behavior changes, or parallel implementation tasks. Completion
requires merging back to the intended branch and cleaning up temporary worktrees.

## Safety

- Never edit `.env*`, service-account files, credential JSON, or secret paths.
- Never run force-push, hard reset, broad cleanup, or recursive deletion unless
  the user explicitly requests and approves it.
- Keep `packages/server/src/*` unchanged for capability alignment unless config
  discovery verification proves a server change is required.
