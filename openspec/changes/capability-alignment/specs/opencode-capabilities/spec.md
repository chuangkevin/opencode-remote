## ADDED Requirements

### Requirement: opencode-remote SHALL own version-controlled opencode capability configuration

`opencode-remote` SHALL be the source repository for opencode runtime capability
configuration, including `opencode.json`, opencode-specific `AGENTS.md`,
`.opencode/agents`, and `.opencode-memory` files.

#### Scenario: Agent needs the authoritative config source

- **WHEN** an agent or user needs to inspect the opencode capability setup
- **THEN** the authoritative files are found in the `opencode-remote` repository
- **AND** workspace-root copies or symlinks are treated as runtime wiring, not as
  separate sources of truth

### Requirement: Configuration SHALL support multiple HomeProject root paths

Capability documentation and config examples SHALL support both
`D:\Projects\_HomeProject` and `D:\GitClone\_HomeProject` by referring to the
runtime workspace as `<HOMEPROJECT_ROOT>` and by relying on the configured
`OPENCODE_DIRECTORY` value.

#### Scenario: Runtime root is D:\Projects

- **WHEN** `.env` sets `OPENCODE_DIRECTORY=D:\Projects\_HomeProject`
- **THEN** setup instructions and verification commands work for that root
- **AND** no source file needs to be edited solely to replace `D:\GitClone`

#### Scenario: Runtime root is D:\GitClone

- **WHEN** `.env` sets `OPENCODE_DIRECTORY=D:\GitClone\_HomeProject`
- **THEN** setup instructions and verification commands work for that root
- **AND** no source file needs to be edited solely to replace `D:\Projects`

#### Scenario: Local runtime settings are missing

- **WHEN** `.env` or `OPENCODE_DIRECTORY` is missing or invalid
- **THEN** `opencode-remote` provides a guided setup command that prompts for the
  missing user-provided values
- **AND** the command writes the local `.env` without committing or printing
  secret values

#### Scenario: Windows opencode CLI path is user-specific

- **WHEN** `opencode-remote` starts on Windows
- **THEN** it resolves the CLI path from `OPENCODE_CLI_PATH` or the current
  user's `%LOCALAPPDATA%\opencode\opencode-cli.exe`
- **AND** source code and documentation do not hard-code one Windows user name

### Requirement: Workspace configuration exposure SHALL be manual in v1

The first implementation SHALL document manual workspace wiring for making
`opencode-remote` config visible from `<HOMEPROJECT_ROOT>`. It SHALL NOT
automatically create symlinks or copies from `start.ps1`, `start-hidden.ps1`, or
proxy server code.

#### Scenario: User chooses symlink setup

- **WHEN** the user follows the documented symlink setup
- **THEN** `<HOMEPROJECT_ROOT>\opencode.json` resolves to the source config in
  `opencode-remote`
- **AND** equivalent links expose `AGENTS.md` and `.opencode\agents`

#### Scenario: User chooses copy fallback

- **WHEN** symlink creation is unavailable or unwanted
- **THEN** the documentation provides copy commands
- **AND** explicitly warns that copied files can drift from the repository source

#### Scenario: User starts opencode-remote with one command

- **WHEN** the user runs `start.ps1` or `start-hidden.ps1`
- **THEN** the script prepares local `.env`, exposes `opencode.json`, `AGENTS.md`,
  and `.opencode\agents` to the runtime root, builds the server, and starts it
- **AND** user-level `pencil` MCP is removed so runtime MCP visibility is driven
  by the shared `opencode-remote` config

### Requirement: MCP configuration SHALL enable core tools with Playwright disabled by default

`opencode.json` SHALL configure filesystem, git, github, and fetch MCP servers as
enabled integrations. It SHALL include Playwright MCP as disabled by default.

#### Scenario: Core MCP tools are inspected

- **WHEN** a new opencode session lists available MCP integrations
- **THEN** filesystem, git, github, and fetch are visible or callable
- **AND** Playwright is present only as a disabled integration

#### Scenario: GitHub MCP needs authentication

- **WHEN** GitHub MCP is configured
- **THEN** its token is read from local environment such as `GITHUB_TOKEN`
- **AND** the real token is not committed to git or printed in verification output

### Requirement: Permissions SHALL use conservative boundaries

The configuration SHALL deny edits to secret-bearing files and deny destructive
bash/git commands. Role-based agents SHALL only receive the permissions needed
for their responsibilities.

#### Scenario: Agent attempts to edit a secret file

- **WHEN** an agent attempts to edit `.env`, `.env.*`, credential JSON, or a
  secret path
- **THEN** the permission policy blocks the edit or requires explicit user action

#### Scenario: Agent attempts destructive git operation

- **WHEN** an agent attempts `git reset --hard`, force push, or broad recursive
  deletion
- **THEN** the permission policy blocks the operation or requires explicit user
  action

### Requirement: opencode SHALL have concise workspace rules and file memory

`opencode-remote` SHALL provide an opencode `AGENTS.md` rule entrypoint and a
file-based memory index under `.opencode-memory`. The rules SHALL identify the
runtime as opencode/GPT-5.5 and SHALL avoid duplicating large HomeProject rule
sources.

#### Scenario: Agent needs workspace rules

- **WHEN** an opencode session starts after manual workspace wiring
- **THEN** it can read and cite the workspace `AGENTS.md`
- **AND** the file points to HomeProject rule sources without copying them in full

#### Scenario: Agent answers from memory

- **WHEN** the user asks about a durable preference stored in `.opencode-memory`
- **THEN** the agent reads the relevant topic file
- **AND** cites the source memory file in the answer

### Requirement: opencode SHALL provide five role-based subagents

The capability layer SHALL define `explore`, `plan`, `implement`, `verify`, and
`reviewer` subagents with explicit responsibilities and permission boundaries.

#### Scenario: Read-only research is dispatched

- **WHEN** a task only requires repository exploration
- **THEN** the `explore` subagent can run with read-only permissions
- **AND** it returns bounded findings with file paths or git references

#### Scenario: Verification is dispatched

- **WHEN** a task requires tests, builds, type checks, or smoke checks
- **THEN** the `verify` subagent can run the requested commands without editing
  files or committing changes

#### Scenario: Implementation is dispatched

- **WHEN** implementation is delegated to the `implement` subagent
- **THEN** it runs with strict write permissions
- **AND** opencode-authored commits use
  `Co-Authored-By: Kevin-AI <kevin950805@gmail.com>`

### Requirement: Large or high-risk work SHALL use worktree isolation

The workflow rules SHALL require worktree isolation for cross-repo changes,
changes touching three or more files, high-risk behavior changes, or parallel
implementation tasks.

#### Scenario: Cross-repo change is planned

- **WHEN** a task changes more than one repository
- **THEN** the implementation plan requires worktree isolation
- **AND** completion requires merge-back and worktree cleanup evidence

#### Scenario: Small single-repo change is planned

- **WHEN** a task is a small single-repo change below the worktree threshold
- **THEN** the workflow may proceed in the main checkout
- **AND** the usual verification and completion checklist still applies

### Requirement: Capability alignment SHALL be verified through practical runtime checks

Completion SHALL be proven with checks for config visibility, MCP visibility,
AGENTS visibility, memory lookup, and subagent dispatch.

#### Scenario: Capability implementation is complete

- **WHEN** the implementation is ready for handoff
- **THEN** verification evidence includes config visibility, core MCP visibility,
  AGENTS citation, memory citation, and read-only subagent dispatch
- **AND** repository validation includes `npm run typecheck` and `npm run build`

#### Scenario: Verification fails because config is not discovered

- **WHEN** OpenCode cannot discover the manually wired configuration
- **THEN** the failure is recorded with the exact setup used
- **AND** server code changes are discussed separately instead of silently
  changing proxy behavior
