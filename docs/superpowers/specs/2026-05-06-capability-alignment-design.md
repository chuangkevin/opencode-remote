# opencode-remote Capability Alignment Design

> Status: approved design draft from superpowers:brainstorming
> Date: 2026-05-06
> Scope: Full Plan capability alignment for opencode/GPT-5.5 runtime

## Goal

Turn `opencode-remote` into the version-controlled control plane for the local
opencode/GPT-5.5 coding environment, while keeping the existing transparent HTTP
proxy stable. The work aligns opencode with the useful parts of Claude Code
Cowork/Dispatch: shared rules, MCP tools, file memory, role-based subagents,
large-change worktree isolation, and practical verification.

## Non-Goals

- Do not rewrite the proxy or change OpenCode SPA redirect behavior.
- Do not automatically create workspace symlinks or copies from startup scripts.
- Do not make `packages/server/src/*` changes unless verification proves config
  loading cannot work without them.
- Do not enable Playwright MCP by default.
- Do not store real tokens in git.

## Decisions

### 1. Ownership

`opencode-remote` owns the opencode capability configuration:

- `opencode.json`
- `AGENTS.md`
- `.opencode/agents/*.md`
- `.opencode-memory/MEMORY.md` and topic files
- OpenSpec change files under `openspec/changes/capability-alignment/`
- this superpower design document

The existing `docs/capability-alignment-plan.md` remains a reference and should
be revised during implementation so it no longer treats `D:\GitClone\_HomeProject`
as the only valid workspace root.

### 2. Workspace Root

The design supports both current HomeProject root layouts:

- `D:\Projects\_HomeProject`
- `D:\GitClone\_HomeProject`

Documentation and config examples must use `<HOMEPROJECT_ROOT>` and the runtime
value of `OPENCODE_DIRECTORY` rather than hard-coding one path as the only truth.

### 3. Manual Workspace Wiring

The source files live in `opencode-remote`, but OpenCode usually runs with cwd
set to `<HOMEPROJECT_ROOT>`. The first version uses manual setup instead of
startup automation:

- Preferred: create symlinks in `<HOMEPROJECT_ROOT>` pointing to the files under
  `opencode-remote`.
- Fallback: copy the files manually and accept a documented drift risk.

Manual setup must cover at least:

- `<HOMEPROJECT_ROOT>\opencode.json`
- `<HOMEPROJECT_ROOT>\AGENTS.md`
- `<HOMEPROJECT_ROOT>\.opencode\agents\*`

The implementation plan must include exact PowerShell commands for both symlink
and copy fallback, plus verification commands.

### 4. MCP Scope

First version MCP configuration:

- Enable `filesystem`, rooted at `<HOMEPROJECT_ROOT>`.
- Enable `git` for workspace repository operations.
- Enable `github`, authenticated by `GITHUB_TOKEN` from `opencode-remote/.env`.
- Enable `fetch` for URL/document retrieval.
- Include `playwright` but keep it disabled by default.

`.env.example` may document `GITHUB_TOKEN=`, but the real token remains local-only.

### 5. Permission Boundary

Use conservative permissions:

- Deny edits to `.env*`, secrets, service account JSON files, credentials, and
  other AI memory directories.
- Deny destructive or irreversible git/bash operations such as force-push,
  hard reset, recursive deletion, and shell writes to `.env*`.
- Keep read-only subagents read-only.
- Allow the `implement` subagent, but only with strict allow/deny rules.

### 6. Rules And Memory

`opencode-remote/AGENTS.md` is the opencode rule entrypoint. It should identify
the runtime as opencode/GPT-5.5 and point to HomeProject rule sources without
copying large `homelab-docs/CLAUDE.md` sections.

File memory lives at `opencode-remote/.opencode-memory/`:

- `MEMORY.md` is a small always-readable index.
- Topic files carry frontmatter with `name`, `description`, and `type`.
- Memory is a hint, not source of truth. Code/runtime claims must be re-verified
  against live files, git, or runtime checks.

### 7. Subagents

Create five role definitions:

- `explore`: read-only codebase/repo research.
- `plan`: read-only planning and spec/plan synthesis.
- `implement`: strict write-capable implementation agent.
- `verify`: no-edit test/build/smoke verification agent.
- `reviewer`: read-only diff/code review agent.

Commit attribution for opencode-authored commits should use:

```text
Co-Authored-By: Kevin-AI <kevin950805@gmail.com>
```

### 8. Worktree Rule

Small single-repo changes may happen in the main checkout. Worktree isolation is
required for:

- cross-repo changes,
- changes touching three or more files,
- high-risk or behavior-changing work,
- parallel implement-agent tasks.

Completion guidance must require merging back to the intended branch and cleaning
up temporary worktrees before reporting completion.

## Formal Spec Strategy

This design is paired with an OpenSpec change:

- `openspec/changes/capability-alignment/proposal.md`
- `openspec/changes/capability-alignment/tasks.md`
- `openspec/changes/capability-alignment/specs/opencode-capabilities/spec.md`

OpenSpec holds the durable requirements. This superpower design captures the
approved architecture decisions and tradeoffs.

## Verification Strategy

Use a practical five-test suite:

1. **Config visibility:** opencode can read workspace `opencode.json`.
2. **MCP visibility:** filesystem/git/github/fetch are visible or callable;
   Playwright is present but disabled.
3. **AGENTS visibility:** opencode can cite workspace `AGENTS.md` rules.
4. **Memory lookup:** opencode can answer a stored preference from
   `.opencode-memory` and cite the source file.
5. **Subagent dispatch:** opencode can dispatch `explore` or `verify` and return
   a read-only result.

## Risks

- OpenCode config discovery may not follow the expected cwd-based lookup. The
  first fallback is manual copy into `<HOMEPROJECT_ROOT>`; server code changes
  remain a last resort.
- MCP package names and config schema may differ from the draft. Implementation
  must verify against the current opencode docs before writing final config.
- Too many always-loaded instruction files can inflate context. The plan should
  keep AGENTS concise and avoid globbing the entire HomeProject rule corpus by
  default.
- Manual setup can drift. The plan must include a visible verification step and
  maintenance note.

## Approval State

The user approved these design sections during brainstorming:

- scope and ownership,
- config loading and manual setup,
- MCP and permission boundary,
- rules, memory, subagents, and worktree,
- OpenSpec, verification, and execution gates.

Implementation must not begin until the written design and OpenSpec change are
reviewed, and a separate writing-plans implementation plan is approved.
