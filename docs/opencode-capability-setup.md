# OpenCode Capability Setup

This document wires the version-controlled opencode capability files from
`opencode-remote` into the HomeProject workspace root used by OpenCode.

## Source And Runtime Paths

- Source repo: `opencode-remote`
- Runtime root: `<HOMEPROJECT_ROOT>` from `OPENCODE_DIRECTORY`
- Supported roots: `D:\Projects\_HomeProject` and `D:\GitClone\_HomeProject`

Run commands from `opencode-remote`.

## Guided Setup

For normal use, run one command:

```powershell
.\start-hidden.ps1
```

The start script runs guided setup in non-interactive mode, builds the project,
and starts the service. It also removes user-level `pencil` MCP from the local
OpenCode config so the shared HomeProject capability config is not polluted by a
desktop-only MCP server.

Use the guided setup when `.env` is missing, `OPENCODE_DIRECTORY` is unknown, or
GitHub MCP needs a local token:

```powershell
.\setup-capabilities.ps1
```

The script prompts for missing values, writes local `.env` without printing
secret values, and wires `opencode.json`, `AGENTS.md`, and `.opencode\agents` to
the runtime root. It prefers symlink/junction wiring and offers copy fallback if
link creation fails.

On Windows, `opencode-remote` resolves the CLI path dynamically. It checks
`OPENCODE_CLI_PATH`, then `%LOCALAPPDATA%\opencode\opencode-cli.exe`, then falls
back to `opencode`. If your CLI is installed elsewhere, set `OPENCODE_CLI_PATH`
in local `.env` or provide it when prompted by setup.

To skip GitHub token input:

```powershell
.\setup-capabilities.ps1 -SkipGithubToken
```

## Read Runtime Root From `.env`

```powershell
$Repo = (Get-Location).Path
$EnvLine = Get-Content "$Repo\.env" | Where-Object { $_ -match '^OPENCODE_DIRECTORY=' } | Select-Object -First 1
if (-not $EnvLine) { .\setup-capabilities.ps1; return }
$HomeProjectRoot = $EnvLine -replace '^OPENCODE_DIRECTORY=', ''
if (-not (Test-Path $HomeProjectRoot)) { .\setup-capabilities.ps1; return }
$HomeProjectRoot
```

Expected: prints the active HomeProject root path.

## Preferred Setup: Symlink Or Junction

Run these commands from `opencode-remote` after the runtime root command above:

```powershell
$Targets = @(
  (Join-Path $HomeProjectRoot 'opencode.json')
  (Join-Path $HomeProjectRoot 'AGENTS.md')
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
not available, run `./setup-capabilities.ps1 -CopyFallback` or use the copy
fallback below.

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
# Paste the real token locally only. Do not commit it.
GITHUB_TOKEN=
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
