# Tasks - capability-alignment

## 1. Specification And Existing Plan Cleanup

- [x] 1.1 Review `docs/capability-alignment-plan.md` and replace hard-coded
      `D:\GitClone\_HomeProject` assumptions with `<HOMEPROJECT_ROOT>` and
      `OPENCODE_DIRECTORY` guidance where appropriate.
- [x] 1.2 Link the existing plan to this OpenSpec change and the superpower
      design doc so future agents know which file is authoritative.
- [x] 1.3 Confirm no implementation task requires changing `packages/server/src/*`
      before config loading has been tested.

      → Existing draft now points to the OpenSpec change and uses path notation
        guidance instead of treating one HomeProject root as authoritative.

## 2. Version-Controlled opencode Configuration

- [x] 2.1 Create `opencode.json` in the `opencode-remote` repo.
- [x] 2.2 Configure filesystem, git, github, and fetch MCP servers.
- [x] 2.3 Include Playwright MCP in the config with `enabled: false`.
- [x] 2.4 Add conservative permission rules for edit and bash operations.
- [x] 2.5 Update `.env.example` with `GITHUB_TOKEN=` documentation only.

      → MCP package names were verified where npm packages are used. Git and
        fetch use currently available packages: `@cyanheads/git-mcp-server` and
        `mcp-fetch-server`. GitHub uses GitHub's official remote MCP endpoint
        `https://api.githubcopilot.com/mcp/` with `GITHUB_TOKEN` auth because
        the earlier npm GitHub MCP package is deprecated.

## 3. Manual Workspace Wiring Documentation

- [x] 3.1 Document symlink setup commands for `<HOMEPROJECT_ROOT>\opencode.json`.
- [x] 3.2 Document copy fallback commands and drift warning.
- [x] 3.3 Document equivalent setup for `AGENTS.md` and `.opencode\agents`.
- [x] 3.4 Add verification commands proving the runtime sees the wired files.
- [x] 3.5 Provide guided setup that prompts for missing local values and writes
      `.env` from user-provided input instead of stopping at missing config.

      → Manual symlink/junction and copy fallback commands are documented in
        `docs/opencode-capability-setup.md` with verification prompts. Missing
        local settings can be filled by `setup-capabilities.ps1`.

## 4. Rules And Memory

- [x] 4.1 Create `AGENTS.md` in `opencode-remote` as the opencode workspace rule
      source.
- [x] 4.2 Keep `AGENTS.md` concise and reference HomeProject rule sources instead
      of copying long `CLAUDE.md` sections.
- [x] 4.3 Create `.opencode-memory/MEMORY.md` and initial topic files.
- [x] 4.4 Document memory write/read triggers and the rule that memory-backed
      code/runtime claims must be re-verified.

      → Rules and memory are owned by `opencode-remote`; AGENTS.md lazy-loads
        HomeProject rule sources, documents memory read/write triggers, and
        makes subagent usage conditional until Task 4 adds the definitions.

## 5. Subagents And Worktree Guidance

- [x] 5.1 Create `.opencode/agents/explore.md` as read-only research.
- [x] 5.2 Create `.opencode/agents/plan.md` as read-only planning.
- [x] 5.3 Create `.opencode/agents/implement.md` with strict write permissions.
- [x] 5.4 Create `.opencode/agents/verify.md` as no-edit verification.
- [x] 5.5 Create `.opencode/agents/reviewer.md` as read-only review.
- [x] 5.6 Add worktree guidance requiring isolation for cross-repo, three-or-more
      file, high-risk, or parallel implementation tasks.
- [x] 5.7 Add commit attribution guidance:
      `Co-Authored-By: Kevin-AI <kevin950805@gmail.com>`.

      → Five markdown subagents were added with explicit permissions. Worktree
        thresholds and Kevin-AI co-author guidance are captured in AGENTS.md and
        implement.md.

## 6. Verification

- [ ] 6.1 Verify config visibility in a new opencode session.
- [ ] 6.2 Verify filesystem/git/github/fetch MCP visibility or callability without
      printing token values.
- [ ] 6.3 Verify workspace `AGENTS.md` can be cited by opencode.
- [ ] 6.4 Verify `.opencode-memory` lookup returns a stored preference with source
      citation.
- [ ] 6.5 Verify `explore` or `verify` subagent dispatch returns a bounded read-only
      result.
- [x] 6.6 Run the repo's concrete validation command after file changes:
      `npm run typecheck` and `npm run build`.

      → `npm run typecheck` passed.
      → `npm run build` passed.

## 7. Handoff

- [ ] 7.1 Record any manual setup steps actually performed during verification.
- [ ] 7.2 Update the OpenSpec task list with verification evidence.
- [ ] 7.3 Stop before implementation if the written design or OpenSpec has not
      been reviewed and approved by the user.
