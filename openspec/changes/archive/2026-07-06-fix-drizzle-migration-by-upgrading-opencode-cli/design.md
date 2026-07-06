# Design: opencode-cli hotfix (no design changes)

This change is an in-place binary replacement of an external dependency. There are no architectural, code, or interface design changes in opencode-remote.

The decision to use **in-place file replacement** over the alternatives is summarized below for traceability:

| Option | Why not chosen |
| --- | --- |
| `opencode upgrade --method curl` | Fails on this Windows host: upgrade script shells out to `/bin/bash` via WSL, which is not installed (`execvpe(/bin/bash) failed`). |
| `opencode upgrade --method npm` | Works, but installs the new binary at `C:\Program Files\nodejs\node_modules\opencode-ai\bin\opencode.exe`. The opencode-remote proxy's `resolveOpenCodeCommand()` checks `process.env.OPENCODE_CLI_PATH` first, then falls back to `%LOCALAPPDATA%\opencode\opencode-cli.exe`. The npm-installed path is not where the proxy looks, so a restart of the proxy would still spawn the old 1.14.30 binary. |
| Set `OPENCODE_CLI_PATH` in `.env` | Avoided because the AGENTS.md rule says not to edit `.env*` manually, and `setup-capabilities.ps1` only prompts for `OPENCODE_CLI_PATH` in interactive mode when no default exists. In-place replacement achieves the same effect with zero `.env` mutation. |
| Reset SQLite DB | Destructive — would lose the user's 2 sessions, 1 project, 853 events, 34 messages, 178 parts. Avoided. |
| Manually seed `__drizzle_migrations` | Requires reverse-engineering the 14 bundled migration hashes from the bun-compiled 1.14.30 binary. Risky and time-consuming. Avoided. |

**Chosen approach**: stop the proxy + opencode-cli via the existing elevated `stop.ps1` allowlist, replace the binary, start via `start.ps1`, re-enable the watchdog.

**Verification**:
- `https://opencode.sisihome.org/remote-health` returns `{"proxy": "opencode-remote", ..., "upstreamHealth": {"healthy": true, "version": "1.17.13"}}`.
- `https://opencode.sisihome.org/remote-sessions` returns 200.
- `http://127.0.0.1:4096/session` returns the existing session list (preserves `ses_0c96f7f79ffe5Ca7IuOHVEQqUy`).
- Watchdog log shows no further `Service unhealthy; restarting` after the upgrade.
