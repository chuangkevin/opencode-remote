# Capability Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a version-controlled opencode/GPT-5.5 capability layer to `opencode-remote` without changing the transparent proxy runtime.

**Architecture:** `opencode-remote` owns the source configuration (`opencode.json`, `AGENTS.md`, `.opencode/agents`, `.opencode-memory`). The HomeProject workspace root exposes those files through manual symlink or copy setup. Core MCP tools, file memory, rules, subagents, and worktree guidance are verified through a practical five-test suite.

**Tech Stack:** Node.js 22, TypeScript, opencode JSON/JSONC config, opencode Markdown agents, MCP servers launched by `npx`, PowerShell manual setup commands.

---

## File Structure

- Modify `docs/capability-alignment-plan.md`: mark the old 917-line draft as reference-only and point to OpenSpec plus this plan.
- Create `opencode.json`: project-owned opencode configuration for MCP, permissions, instructions, and model defaults.
- Modify `.env.example`: document local-only `GITHUB_TOKEN` for GitHub MCP.
- Create `AGENTS.md`: concise opencode workspace rules and lazy-load references to HomeProject rule sources.
- Create `.opencode-memory/MEMORY.md`: small memory index loaded by config.
- Create `.opencode-memory/user_preferences.md`: durable user preference example.
- Create `.opencode-memory/reference_homeproject_paths.md`: runtime path reference.
- Create `.opencode-memory/feedback_git_safety.md`: git safety memory.
- Create `.opencode/agents/explore.md`: read-only research subagent.
- Create `.opencode/agents/plan.md`: read-only planning subagent.
- Create `.opencode/agents/implement.md`: strict write-capable implementation subagent.
- Create `.opencode/agents/verify.md`: no-edit verification subagent.
- Create `.opencode/agents/reviewer.md`: read-only review subagent.
- Create `docs/opencode-capability-setup.md`: manual workspace wiring and verification guide.
- Modify `README.md`: link the setup guide and capability plan.
- Modify `openspec/changes/capability-alignment/tasks.md`: check off completed tasks with verification notes during implementation.

---

### Task 1: Mark The Existing Draft As Reference-Only

**Files:**
- Modify: `docs/capability-alignment-plan.md`
- Modify: `openspec/changes/capability-alignment/tasks.md`

- [ ] **Step 1: Insert an authority notice after the title**

Add this block immediately after `# opencode-remote Capability Alignment Plan`:

```markdown

> **Authoritative follow-up:** This file is the original exploratory draft from
> commit `58b857a`. The approved requirement source is
> `openspec/changes/capability-alignment/`, and the approved design is
> `docs/superpowers/specs/2026-05-06-capability-alignment-design.md`.
> Implementation should follow
> `docs/superpowers/plans/2026-05-06-capability-alignment.md`.

> **Path notation:** References to `D:\GitClone\_HomeProject` in this draft are
> historical examples. New work must use `<HOMEPROJECT_ROOT>` and the runtime
> `OPENCODE_DIRECTORY` value so both `D:\Projects\_HomeProject` and
> `D:\GitClone\_HomeProject` are supported.
```

- [ ] **Step 2: Replace the status line**

Change this line:

```markdown
> **狀態:** 規劃草稿（2026-05-06）
```

to this:

```markdown
> **狀態:** 參考草稿（2026-05-06）；正式需求見 `openspec/changes/capability-alignment/`
```

- [ ] **Step 3: Verify no new hard-coded root was introduced**

Run:

```powershell
Select-String -Path "docs\capability-alignment-plan.md" -Pattern "D:\\GitClone\\_HomeProject|D:\\Projects\\_HomeProject"
```

Expected: matches may remain only in historical examples or in the new path-notation notice. No line should say either path is the only valid root.

- [ ] **Step 4: Update OpenSpec task status for section 1**

In `openspec/changes/capability-alignment/tasks.md`, mark tasks `1.1`, `1.2`, and `1.3` complete after the previous steps are done. Add a short note under section 1:

```markdown
      → Existing draft now points to the OpenSpec change and uses path notation
        guidance instead of treating one HomeProject root as authoritative.
```

- [ ] **Step 5: Commit Task 1**

Run:

```powershell
git add docs/capability-alignment-plan.md openspec/changes/capability-alignment/tasks.md
git commit -m "docs: clarify capability alignment authority"
```

Expected: commit succeeds. If hooks modify files, inspect `git status` and make a new commit with the hook changes; do not amend unless the hook already created the commit and only formatting artifacts need inclusion.

---

### Task 2: Add opencode.json And Environment Documentation

**Files:**
- Create: `opencode.json`
- Modify: `.env.example`
- Modify: `openspec/changes/capability-alignment/tasks.md`

- [ ] **Step 1: Verify MCP package availability**

Run:

```powershell
npm view @modelcontextprotocol/server-filesystem name version
npm view @cyanheads/git-mcp-server name version bin
npm view mcp-fetch-server name version bin
npm view @playwright/mcp name version
```

Expected: each command prints package metadata. GitHub MCP uses GitHub's official remote server `https://api.githubcopilot.com/mcp/` with `GITHUB_TOKEN` auth. `@modelcontextprotocol/server-git` and `@modelcontextprotocol/server-fetch` are not used because they returned npm 404 during planning.

- [ ] **Step 2: Create `opencode.json`**

Write this exact file:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "openai/gpt-5.5",
  "small_model": "openai/gpt-5.5",
  "autoupdate": "notify",
  "instructions": [
    "{env:OPENCODE_DIRECTORY}/opencode-remote/.opencode-memory/MEMORY.md"
  ],
  "permission": {
    "edit": {
      "*": "ask",
      "**/.env": "deny",
      "**/.env.*": "deny",
      "**/*service-account*.json": "deny",
      "**/*credential*.json": "deny",
      "**/secrets/**": "deny",
      "**/.claude-memory/**": "deny"
    },
    "bash": {
      "*": "ask",
      "git status*": "allow",
      "git log*": "allow",
      "git diff*": "allow",
      "git show*": "allow",
      "npm run typecheck": "allow",
      "npm run build": "allow",
      "node --version": "allow",
      "npm --version": "allow",
      "git reset --hard*": "deny",
      "git push --force*": "deny",
      "git clean*": "deny",
      "Remove-Item *": "deny",
      "del *": "deny",
      "rmdir *": "deny",
      "* > .env*": "deny"
    },
    "git_git_reset": "deny",
    "git_git_clean": "deny",
    "git_git_clear_working_dir": "deny",
    "git_git_push": "ask",
    "git_git_commit": "ask",
    "github_*": "ask",
    "filesystem_*": "ask",
    "fetch_*": "allow"
  },
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "{env:OPENCODE_DIRECTORY}"
      ],
      "enabled": true,
      "timeout": 10000
    },
    "git": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@cyanheads/git-mcp-server"
      ],
      "enabled": true,
      "timeout": 10000
    },
    "github": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer {env:GITHUB_TOKEN}"
      },
      "enabled": true,
      "timeout": 10000
    },
    "fetch": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "mcp-fetch-server"
      ],
      "environment": {
        "DEFAULT_LIMIT": "10000"
      },
      "enabled": true,
      "timeout": 10000
    },
    "playwright": {
      "type": "local",
      "command": [
        "npx",
        "-y",
        "@playwright/mcp"
      ],
      "enabled": false,
      "timeout": 30000
    }
  }
}
```

- [ ] **Step 3: Validate JSON syntax**

Run:

```powershell
node -e "JSON.parse(require('fs').readFileSync('opencode.json','utf8')); console.log('opencode.json ok')"
```

Expected output:

```text
opencode.json ok
```

- [ ] **Step 4: Update `.env.example`**

Append this exact block:

```env

# Optional: local-only token used by the GitHub MCP server in opencode.json
# Do not commit a real token. Keep the real value in .env only.
GITHUB_TOKEN=
```

- [ ] **Step 5: Update OpenSpec task status for section 2**

In `openspec/changes/capability-alignment/tasks.md`, mark tasks `2.1` through `2.5` complete and add this note:

```markdown
      → MCP package names were verified on npm. Git and fetch use currently
        available packages: `@cyanheads/git-mcp-server` and `mcp-fetch-server`.
```

- [ ] **Step 6: Commit Task 2**

Run:

```powershell
git add opencode.json .env.example openspec/changes/capability-alignment/tasks.md
git commit -m "feat: add opencode capability config"
```

Expected: commit succeeds and no real token appears in staged diff.

---

### Task 3: Add Workspace Rules And File Memory

**Files:**
- Create: `AGENTS.md`
- Create: `.opencode-memory/MEMORY.md`
- Create: `.opencode-memory/user_preferences.md`
- Create: `.opencode-memory/reference_homeproject_paths.md`
- Create: `.opencode-memory/feedback_git_safety.md`
- Modify: `openspec/changes/capability-alignment/tasks.md`

- [ ] **Step 1: Create `AGENTS.md`**

Write this exact file:

```markdown
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

- Read `opencode-remote/.opencode-memory/MEMORY.md` before answering questions
  about remembered user preferences or previous durable decisions.
- Topic files use `type: user`, `type: feedback`, `type: project`, or
  `type: reference` frontmatter.
- Memory is a hint, not a source of truth. Re-read live code, git, docs, or
  runtime state before acting on memory about files, services, or behavior.

## MCP Usage

- Use filesystem MCP for structured workspace file reads when helpful.
- Use git MCP for read-oriented repository inspection; destructive git MCP tools
  are denied by config.
- Use GitHub MCP only when GitHub API access is actually needed.
- Use fetch MCP for URL to markdown/text retrieval.
- Playwright MCP is present but disabled by default.

## Subagents

- Use `explore` for read-only codebase or git research.
- Use `plan` for read-only planning and spec synthesis.
- Use `implement` only for bounded implementation work with strict permissions.
- Use `verify` for no-edit test/build/smoke verification.
- Use `reviewer` for read-only diff and code review.

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
```

- [ ] **Step 2: Create `.opencode-memory/MEMORY.md`**

Write this exact file:

```markdown
# opencode Memory Index

- [User preferences](user_preferences.md) — durable Kevin/HomeProject preferences for opencode sessions.
- [HomeProject paths](reference_homeproject_paths.md) — supported workspace root path strategy.
- [Git safety](feedback_git_safety.md) — destructive git operations and force-push policy.
```

- [ ] **Step 3: Create `.opencode-memory/user_preferences.md`**

Write this exact file:

```markdown
---
name: user_preferences
description: Durable user preferences for HomeProject opencode sessions.
type: user
---

- Kevin prefers Traditional Chinese for user-facing text.
- Kevin's GitHub push account for repos under `kevinsisi` is `chuangkevin`.
- opencode-authored commits should use `Co-Authored-By: Kevin-AI <kevin950805@gmail.com>`.
- Prefer Tailscale and free/self-hosted options where feasible.
```

- [ ] **Step 4: Create `.opencode-memory/reference_homeproject_paths.md`**

Write this exact file:

```markdown
---
name: reference_homeproject_paths
description: HomeProject workspace root paths supported by opencode-remote capability config.
type: reference
---

- Treat `OPENCODE_DIRECTORY` as `<HOMEPROJECT_ROOT>`.
- Supported roots include `D:\Projects\_HomeProject` and `D:\GitClone\_HomeProject`.
- Do not assume one root is globally authoritative when writing new docs or config.
- `opencode-remote` owns the source config. Workspace-root files are symlinked or copied runtime wiring.
```

- [ ] **Step 5: Create `.opencode-memory/feedback_git_safety.md`**

Write this exact file:

```markdown
---
name: feedback_git_safety
description: Git safety rules learned from HomeProject workflow preferences.
type: feedback
---

- Never run `git push --force` to `main` or `master`.
- Never use `git reset --hard` or broad cleanup commands unless the user explicitly requests them.
- Commit only when the user has asked for commit or when the active workflow explicitly requires it.
- For large or risky work, prefer worktree isolation and merge back only after verification.
```

- [ ] **Step 6: Verify memory index paths**

Run:

```powershell
Test-Path .opencode-memory\MEMORY.md
Test-Path .opencode-memory\user_preferences.md
Test-Path .opencode-memory\reference_homeproject_paths.md
Test-Path .opencode-memory\feedback_git_safety.md
```

Expected output: four `True` lines.

- [ ] **Step 7: Update OpenSpec task status for section 4**

In `openspec/changes/capability-alignment/tasks.md`, mark tasks `4.1` through `4.4` complete and add this note:

```markdown
      → Rules and memory are owned by `opencode-remote`; AGENTS.md lazy-loads
        HomeProject rule sources and memory files cite their source paths.
```

- [ ] **Step 8: Commit Task 3**

Run:

```powershell
git add AGENTS.md .opencode-memory openspec/changes/capability-alignment/tasks.md
git commit -m "feat: add opencode rules and memory"
```

Expected: commit succeeds.

---

### Task 4: Add Role-Based Subagents

**Files:**
- Create: `.opencode/agents/explore.md`
- Create: `.opencode/agents/plan.md`
- Create: `.opencode/agents/implement.md`
- Create: `.opencode/agents/verify.md`
- Create: `.opencode/agents/reviewer.md`
- Modify: `openspec/changes/capability-alignment/tasks.md`

- [ ] **Step 1: Create `.opencode/agents/explore.md`**

Write this exact file:

```markdown
---
description: Read-only codebase and git research. Use for finding files, tracing patterns, and reporting grounded findings without edits.
mode: subagent
model: openai/gpt-5.5
temperature: 0.2
steps: 20
permission:
  edit: deny
  bash:
    "*": deny
    "git status*": allow
    "git log*": allow
    "git diff*": allow
    "git show*": allow
  webfetch: ask
  websearch: deny
color: blue
---

You are the Explore subagent.

- Find and report facts grounded in files, git output, or fetched docs.
- Do not edit files, write patches, commit, push, or run mutating shell commands.
- Include exact file paths and line references where available.
- Keep the final report under 600 words unless the caller asks for deeper detail.
```

- [ ] **Step 2: Create `.opencode/agents/plan.md`**

Write this exact file:

```markdown
---
description: Read-only planning agent. Use for OpenSpec/design/implementation-plan synthesis before code changes.
mode: subagent
model: openai/gpt-5.5
temperature: 0.3
steps: 30
permission:
  edit: deny
  bash:
    "*": deny
    "git status*": allow
    "git log*": allow
    "git diff*": allow
    "git show*": allow
  webfetch: ask
  websearch: ask
color: purple
---

You are the Plan subagent.

- Produce reviewable plans, not code changes.
- Honor `homelab-docs/skills/plan-before-build/SKILL.md` when the task is a new feature or non-trivial behavior change.
- Call out scope boundaries, risks, exact files to touch, and verification commands.
- Do not edit files or run mutating commands.
```

- [ ] **Step 3: Create `.opencode/agents/implement.md`**

Write this exact file:

```markdown
---
description: Strict implementation agent. Use only for bounded implementation tasks after an approved plan exists.
mode: subagent
model: openai/gpt-5.5
temperature: 0.3
steps: 60
permission:
  edit:
    "*": ask
    "**/.env": deny
    "**/.env.*": deny
    "**/*service-account*.json": deny
    "**/*credential*.json": deny
    "**/secrets/**": deny
    "**/.claude-memory/**": deny
  bash:
    "*": ask
    "git status*": allow
    "git log*": allow
    "git diff*": allow
    "git show*": allow
    "npm run typecheck": allow
    "npm run build": allow
    "git reset --hard*": deny
    "git push --force*": deny
    "git clean*": deny
    "Remove-Item *": deny
    "del *": deny
    "rmdir *": deny
    "* > .env*": deny
  webfetch: ask
  websearch: ask
color: green
---

You are the Implement subagent.

- Only work from an approved plan or a clearly bounded task.
- Make the smallest correct change.
- Never edit secrets, `.env*`, credential files, or `.claude-memory` files.
- Run the verification command named by the caller.
- If committing is explicitly requested by the caller or required by the active workflow, use:
  `Co-Authored-By: Kevin-AI <kevin950805@gmail.com>`.
- For cross-repo, three-or-more-file, high-risk, or parallel implementation tasks, use worktree isolation and report merge-back status.
```

- [ ] **Step 4: Create `.opencode/agents/verify.md`**

Write this exact file:

```markdown
---
description: No-edit verification agent. Use for tests, builds, type checks, smoke checks, and reporting evidence.
mode: subagent
model: openai/gpt-5.5
temperature: 0.1
steps: 20
permission:
  edit: deny
  bash:
    "*": ask
    "npm run typecheck": allow
    "npm run build": allow
    "npm test*": allow
    "node *": allow
    "curl *": allow
    "git status*": allow
    "git log*": allow
    "git diff*": allow
  webfetch: ask
  websearch: deny
color: yellow
---

You are the Verify subagent.

- Run only the verification commands requested by the caller or required by the plan.
- Do not edit files, commit, push, or fix failures.
- Return PASS or FAIL with command output excerpts and exact commands used.
- If a command cannot run, report the concrete reason instead of guessing.
```

- [ ] **Step 5: Create `.opencode/agents/reviewer.md`**

Write this exact file:

```markdown
---
description: Read-only code review agent. Use for reviewing diffs, risks, missing tests, and spec alignment.
mode: subagent
model: openai/gpt-5.5
temperature: 0.2
steps: 25
permission:
  edit: deny
  bash:
    "*": deny
    "git status*": allow
    "git diff*": allow
    "git log*": allow
    "git show*": allow
  webfetch: ask
  websearch: ask
color: red
---

You are the Reviewer subagent.

- Review diffs or commit ranges for correctness, security, regressions, style consistency, missing tests, and spec alignment.
- Findings come first, ordered by severity, with file paths and line references where available.
- Do not edit files, propose broad rewrites, commit, or push.
- If no findings are discovered, state that explicitly and list residual risks.
```

- [ ] **Step 6: Validate agent frontmatter is parseable YAML-like text**

Run:

```powershell
Get-ChildItem .opencode\agents\*.md | ForEach-Object {
  $text = Get-Content $_.FullName -Raw
  if ($text -notmatch '^---') { throw "$($_.Name) missing opening frontmatter" }
  if (($text -split '---').Count -lt 3) { throw "$($_.Name) missing closing frontmatter" }
  $_.Name
}
```

Expected output includes:

```text
explore.md
plan.md
implement.md
verify.md
reviewer.md
```

- [ ] **Step 7: Update OpenSpec task status for section 5**

In `openspec/changes/capability-alignment/tasks.md`, mark tasks `5.1` through `5.7` complete and add this note:

```markdown
      → Five markdown subagents were added with explicit permissions. Worktree
        thresholds and Kevin-AI co-author guidance are captured in AGENTS.md and
        implement.md.
```

- [ ] **Step 8: Commit Task 4**

Run:

```powershell
git add .opencode openspec/changes/capability-alignment/tasks.md
git commit -m "feat: add opencode role subagents"
```

Expected: commit succeeds.

---

### Task 5: Add Manual Setup And Verification Documentation

**Files:**
- Create: `docs/opencode-capability-setup.md`
- Modify: `README.md`
- Modify: `openspec/changes/capability-alignment/tasks.md`

- [ ] **Step 1: Create `docs/opencode-capability-setup.md`**

Write this exact file:

```markdown
# OpenCode Capability Setup

This document wires the version-controlled opencode capability files from
`opencode-remote` into the HomeProject workspace root used by OpenCode.

## Source And Runtime Paths

- Source repo: `opencode-remote`
- Runtime root: `<HOMEPROJECT_ROOT>` from `OPENCODE_DIRECTORY`
- Supported roots: `D:\Projects\_HomeProject` and `D:\GitClone\_HomeProject`

Run commands from `opencode-remote`.

## Read Runtime Root From `.env`

```powershell
$Repo = (Get-Location).Path
$EnvLine = Get-Content "$Repo\.env" | Where-Object { $_ -match '^OPENCODE_DIRECTORY=' } | Select-Object -First 1
if (-not $EnvLine) { throw 'OPENCODE_DIRECTORY is missing from .env' }
$HomeProjectRoot = $EnvLine -replace '^OPENCODE_DIRECTORY=', ''
if (-not (Test-Path $HomeProjectRoot)) { throw "HomeProject root does not exist: $HomeProjectRoot" }
$HomeProjectRoot
```

Expected: prints the active HomeProject root path.

## Preferred Setup: Symlink Or Junction

Run these commands from `opencode-remote` after the runtime root command above:

```powershell
$Targets = @(
  Join-Path $HomeProjectRoot 'opencode.json',
  Join-Path $HomeProjectRoot 'AGENTS.md'
)
$Targets | ForEach-Object {
  if (Test-Path $_) { throw "Refusing to overwrite existing path: $_" }
}

New-Item -ItemType SymbolicLink -Path (Join-Path $HomeProjectRoot 'opencode.json') -Target (Join-Path $Repo 'opencode.json')
New-Item -ItemType SymbolicLink -Path (Join-Path $HomeProjectRoot 'AGENTS.md') -Target (Join-Path $Repo 'AGENTS.md')
New-Item -ItemType Directory -Force -Path (Join-Path $HomeProjectRoot '.opencode')

$AgentTarget = Join-Path $HomeProjectRoot '.opencode\agents'
if (Test-Path $AgentTarget) { throw "Refusing to overwrite existing path: $AgentTarget" }
New-Item -ItemType Junction -Path $AgentTarget -Target (Join-Path $Repo '.opencode\agents')
```

If symbolic link creation fails because Windows Developer Mode or privileges are
not available, use the copy fallback below.

## Fallback Setup: Copy

Copied files can drift. Re-copy them after changing source files in
`opencode-remote`.

```powershell
Copy-Item (Join-Path $Repo 'opencode.json') (Join-Path $HomeProjectRoot 'opencode.json')
Copy-Item (Join-Path $Repo 'AGENTS.md') (Join-Path $HomeProjectRoot 'AGENTS.md')
New-Item -ItemType Directory -Force -Path (Join-Path $HomeProjectRoot '.opencode\agents')
Copy-Item (Join-Path $Repo '.opencode\agents\*.md') (Join-Path $HomeProjectRoot '.opencode\agents') -Force
```

## Local GitHub Token

GitHub MCP reads `GITHUB_TOKEN` from `opencode-remote/.env`. Add it locally only:

```env
GITHUB_TOKEN=ghp_your_local_token_here
```

Do not commit the real token.

## Restart And Verify Service

```powershell
.\restart-service.ps1
Start-Sleep -Seconds 10
curl http://localhost:4096/global/health
curl -I http://localhost:9223/
```

Expected:

- OpenCode health returns JSON with `healthy: true`.
- Proxy root returns a redirect to a session URL.

## Verify Capability Loading In OpenCode

Open `https://opencode.sisihome.org/` or `http://localhost:9223/` and run these
manual prompts in a new session:

1. `List the opencode MCP integrations you can see. Do not print token values.`
2. `What rule file tells you the Kevin-AI co-author line? Cite the file.`
3. `What is my GitHub push account for kevinsisi repos? Cite the memory file.`
4. `Use the explore subagent to list the latest three commits in opencode-remote.`
5. `Use the verify subagent to run npm run typecheck for opencode-remote.`

Expected:

- filesystem, git, github, and fetch MCP are visible or callable.
- Playwright is disabled by default.
- `AGENTS.md` is cited for the Kevin-AI co-author line.
- `.opencode-memory/user_preferences.md` is cited for `chuangkevin`.
- `explore` or `verify` returns a bounded read-only result.
```

- [ ] **Step 2: Add README link**

Append this section to `README.md` after the `詳細文件` list:

```markdown

## OpenCode Capability Setup

- [docs/opencode-capability-setup.md](./docs/opencode-capability-setup.md) — manual workspace wiring for `opencode.json`, `AGENTS.md`, MCP, memory, and subagents
- [docs/superpowers/specs/2026-05-06-capability-alignment-design.md](./docs/superpowers/specs/2026-05-06-capability-alignment-design.md) — approved capability alignment design
- [openspec/changes/capability-alignment/](./openspec/changes/capability-alignment/) — formal OpenSpec change
```

- [ ] **Step 3: Update OpenSpec task status for section 3**

In `openspec/changes/capability-alignment/tasks.md`, mark tasks `3.1` through `3.4` complete and add this note:

```markdown
      → Manual symlink/junction and copy fallback commands are documented in
        `docs/opencode-capability-setup.md` with verification prompts.
```

- [ ] **Step 4: Commit Task 5**

Run:

```powershell
git add docs/opencode-capability-setup.md README.md openspec/changes/capability-alignment/tasks.md
git commit -m "docs: add opencode capability setup guide"
```

Expected: commit succeeds.

---

### Task 6: Run Repository Validation

**Files:**
- Modify: `openspec/changes/capability-alignment/tasks.md`

- [ ] **Step 1: Run typecheck**

Run:

```powershell
npm run typecheck
```

Expected: TypeScript completes without errors.

- [ ] **Step 2: Run build**

Run:

```powershell
npm run build
```

Expected: `tsc -p tsconfig.json` completes without errors.

- [ ] **Step 3: Re-check git status**

Run:

```powershell
git status --short
```

Expected: only intentional uncommitted files remain. If validation changed `packages/server/dist/*`, inspect the diff and include it only if it reflects the current source build.

- [ ] **Step 4: Update OpenSpec validation task**

In `openspec/changes/capability-alignment/tasks.md`, mark task `6.6` complete and add the command evidence:

```markdown
      → `npm run typecheck` passed.
      → `npm run build` passed.
```

- [ ] **Step 5: Commit Task 6**

Run:

```powershell
git add openspec/changes/capability-alignment/tasks.md packages/server/dist
git commit -m "chore: record capability validation"
```

Expected: if `packages/server/dist` did not change, omit it from `git add`. If no files changed, do not create an empty commit.

---

### Task 7: Perform Manual Workspace Wiring And Runtime Verification

**Files:**
- Modify: `openspec/changes/capability-alignment/tasks.md`

- [ ] **Step 1: Run symlink or copy setup**

Follow `docs/opencode-capability-setup.md`. Prefer symlink/junction setup. Use copy fallback only if symlink or junction creation fails.

Expected: workspace root contains runtime-visible `opencode.json`, `AGENTS.md`, and `.opencode\agents`.

- [ ] **Step 2: Restart service**

Run:

```powershell
.\restart-service.ps1
Start-Sleep -Seconds 10
curl http://localhost:4096/global/health
curl -I http://localhost:9223/
```

Expected:

- `curl http://localhost:4096/global/health` returns healthy JSON.
- `curl -I http://localhost:9223/` returns a redirect response.

- [ ] **Step 3: Run capability prompt checks**

Open `http://localhost:9223/` or `https://opencode.sisihome.org/` and run the five prompts from `docs/opencode-capability-setup.md`.

Expected:

- Config/MCP visibility passes.
- `AGENTS.md` citation passes.
- Memory citation for `chuangkevin` passes.
- `explore` or `verify` subagent dispatch passes.

- [ ] **Step 4: Record runtime verification evidence**

In `openspec/changes/capability-alignment/tasks.md`, mark tasks `6.1` through `6.5` complete only for checks that actually passed. Under section 6, add a concise evidence note with the date, runtime root, and setup mode:

```markdown
      → Runtime verification date: 2026-05-06.
      → Runtime root: `<actual OPENCODE_DIRECTORY value>`.
      → Setup mode: symlink/junction or copy fallback.
      → Config, MCP, AGENTS, memory, and subagent checks passed.
```

Replace `<actual OPENCODE_DIRECTORY value>` with the real path used during verification.

- [ ] **Step 5: Commit Task 7**

Run:

```powershell
git add openspec/changes/capability-alignment/tasks.md
git commit -m "test: verify opencode capability loading"
```

Expected: commit succeeds only after actual runtime verification has evidence.

---

### Task 8: Final Handoff, Review, And Push

**Files:**
- Modify: `openspec/changes/capability-alignment/tasks.md`

- [ ] **Step 1: Final diff review**

Run:

```powershell
git status --short
git log --oneline -n 8
git diff HEAD
```

Expected: no accidental secret, no unrelated changes, no unexpected server source changes.

- [ ] **Step 2: Mark handoff tasks complete**

In `openspec/changes/capability-alignment/tasks.md`, mark `7.1` and `7.2` complete after recording setup evidence. Mark `7.3` complete with this note:

```markdown
      → Design and OpenSpec were approved before this implementation plan was
        executed. Implementation followed the approved writing plan.
```

- [ ] **Step 3: Commit final task update if needed**

Run:

```powershell
git add openspec/changes/capability-alignment/tasks.md
git commit -m "docs: complete capability alignment tasks"
```

Expected: if there are no changes, do not create an empty commit.

- [ ] **Step 4: Push commits if requested by active workflow**

Run:

```powershell
git status --short
git branch --show-current
git push
```

Expected: push succeeds from the active branch. If authentication fails, report the exact error and do not force push.

- [ ] **Step 5: Handoff summary**

Report:

- Files created and modified.
- Commits created.
- Runtime root used.
- Setup mode used.
- Verification evidence for config, MCP, AGENTS, memory, subagent, typecheck, and build.
- Any unresolved risks, especially MCP package behavior or manual setup drift.

---

## Self-Review

- Spec coverage: Tasks cover OpenSpec requirements for ownership, dual-root support, manual wiring, MCP, permissions, rules, memory, subagents, worktree, and verification.
- Placeholder scan: This plan contains concrete file paths, exact file contents, exact commands, and expected outputs.
- Type/config consistency: opencode config uses current docs fields: `instructions`, `permission`, `mcp`, `model`, and `small_model`. Markdown agents use `description`, `mode`, `model`, `temperature`, `steps`, `permission`, and `color` frontmatter.
- Package consistency: npm package checks use packages verified during planning: `@modelcontextprotocol/server-filesystem`, `@cyanheads/git-mcp-server`, `mcp-fetch-server`, and `@playwright/mcp`; GitHub uses the official remote MCP endpoint.

---

## Execution Choice

Plan complete and saved to `docs/superpowers/plans/2026-05-06-capability-alignment.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.

2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
