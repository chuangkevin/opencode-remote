# capability-alignment

## Why

`opencode-remote` currently exposes OpenCode's native web UI reliably, but the
opencode/GPT-5.5 runtime does not yet have the surrounding capability layer used
by the rest of HomeProject AI workflows: explicit rules, MCP tools, file memory,
role-based subagents, and worktree guidance.

The existing `docs/capability-alignment-plan.md` is a useful draft, but it is not
yet a formal requirement source and contains path assumptions tied to
`D:\GitClone\_HomeProject`. This change captures the approved capability design
as OpenSpec before implementation.

## What Changes

- Add a version-controlled opencode configuration owned by `opencode-remote`.
- Support both `D:\Projects\_HomeProject` and `D:\GitClone\_HomeProject` by
  documenting `<HOMEPROJECT_ROOT>` and relying on `OPENCODE_DIRECTORY`.
- Define manual workspace wiring for `opencode.json`, `AGENTS.md`, and
  `.opencode/agents` instead of modifying startup scripts automatically.
- Add MCP configuration for filesystem, git, github, and fetch; include
  Playwright disabled by default.
- Add file-based opencode memory under `opencode-remote/.opencode-memory/`.
- Add five role-based subagents with explicit permission boundaries.
- Add worktree requirements for large, high-risk, or cross-repo work.
- Define practical verification for config, MCP, AGENTS, memory, and subagent
  behavior.

## Non-Goals

- No proxy rewrite.
- No OpenCode SPA URL behavior changes.
- No automatic symlink/copy creation in `start.ps1` or `start-hidden.ps1`.
- No real tokens committed to git.
- No default Playwright MCP enablement.
- No broad migration of every HomeProject repo to per-project `AGENTS.md` in
  this first implementation.

## Impact

- Runtime proxy behavior should remain unchanged.
- Operators will perform one manual workspace setup step per HomeProject root.
- opencode sessions should gain reproducible access to rules, memory, MCP tools,
  and subagents after setup.
- The change introduces no required runtime npm dependency for the proxy itself;
  MCP packages may be invoked by opencode via `npx` or equivalent runtime config.

## Success Criteria

- A new opencode session can confirm it loaded the workspace config.
- The filesystem, git, github, and fetch MCP integrations are visible or callable
  without exposing secret values.
- The workspace rule file can be cited by opencode.
- A stored memory preference can be read from `.opencode-memory` with source-file
  citation.
- A read-only subagent dispatch, such as `explore` or `verify`, can run and
  return a bounded result.

## Notes For Implementer

- Keep `packages/server/src/*` unchanged unless a verification failure proves a
  server code change is necessary.
- Treat `<HOMEPROJECT_ROOT>` as the path currently configured by
  `OPENCODE_DIRECTORY`.
- Commit attribution rule for opencode-authored commits:
  `Co-Authored-By: Kevin-AI <kevin950805@gmail.com>`.
- Use the paired design doc at
  `docs/superpowers/specs/2026-05-06-capability-alignment-design.md` for
  architectural rationale.
