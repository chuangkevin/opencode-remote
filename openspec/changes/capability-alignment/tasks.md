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

- [ ] 3.1 Document symlink setup commands for `<HOMEPROJECT_ROOT>\opencode.json`.
- [ ] 3.2 Document copy fallback commands and drift warning.
- [ ] 3.3 Document equivalent setup for `AGENTS.md` and `.opencode\agents`.
- [ ] 3.4 Add verification commands proving the runtime sees the wired files.

## 4. Rules And Memory

- [x] 4.1 Create `AGENTS.md` in `opencode-remote` as the opencode workspace rule
      source.
- [x] 4.2 Keep `AGENTS.md` concise and reference HomeProject rule sources instead
      of copying long `CLAUDE.md` sections.
- [x] 4.3 Create `.opencode-memory/MEMORY.md` and initial topic files.
- [x] 4.4 Document memory write/read triggers and the rule that memory-backed
      code/runtime claims must be re-verified.

      → Rules and memory are owned by `opencode-remote`; AGENTS.md lazy-loads
        HomeProject rule sources and memory files cite their source paths.

## 5. Subagents And Worktree Guidance

- [ ] 5.1 Create `.opencode/agents/explore.md` as read-only research.
- [ ] 5.2 Create `.opencode/agents/plan.md` as read-only planning.
- [ ] 5.3 Create `.opencode/agents/implement.md` with strict write permissions.
- [ ] 5.4 Create `.opencode/agents/verify.md` as no-edit verification.
- [ ] 5.5 Create `.opencode/agents/reviewer.md` as read-only review.
- [ ] 5.6 Add worktree guidance requiring isolation for cross-repo, three-or-more
      file, high-risk, or parallel implementation tasks.
- [ ] 5.7 Add commit attribution guidance:
      `Co-Authored-By: Kevin-AI <kevin950805@gmail.com>`.

## 6. Verification

- [ ] 6.1 Verify config visibility in a new opencode session.
- [ ] 6.2 Verify filesystem/git/github/fetch MCP visibility or callability without
      printing token values.
- [ ] 6.3 Verify workspace `AGENTS.md` can be cited by opencode.
- [ ] 6.4 Verify `.opencode-memory` lookup returns a stored preference with source
      citation.
- [ ] 6.5 Verify `explore` or `verify` subagent dispatch returns a bounded read-only
      result.
- [ ] 6.6 Run the repo's concrete validation command after file changes:
      `npm run typecheck` and `npm run build`.

## 7. Handoff

- [ ] 7.1 Record any manual setup steps actually performed during verification.
- [ ] 7.2 Update the OpenSpec task list with verification evidence.
- [ ] 7.3 Stop before implementation if the written design or OpenSpec has not
      been reviewed and approved by the user.
