# Fix Drizzle migration by upgrading opencode-cli

## Why

`https://opencode.sisihome.org/remote-sessions` and `https://opencode.sisihome.org/remote-health` began returning **500** during routine use on 2026-07-06. Root cause: the opencode-cli binary shipping at `%LOCALAPPDATA%\opencode\opencode-cli.exe` is v1.14.30, but the SQLite database at `%USERPROFILE%\.local\share\opencode\opencode.db` was created by a newer opencode (its `project` table already includes `icon_url_override` and `commands` columns that 1.14.30's bundled migration does not know about). When 1.14.30 starts, Drizzle's `__drizzle_migrations` table is empty, so it tries to re-run `CREATE TABLE project (...)` and fails with `table project already exists`. Every request to `/session` and `/health` then returns 500 with `DrizzleError`.

The opencode-remote watchdog (`run-watchdog-hidden.vbs` → `ensure-service.ps1`) detected the failing `/remote-sessions` and restarted the proxy every 5 minutes, but the upstream was still broken, so the 500 never cleared. Users saw the desktop Caddy 502 fallback "Desktop Caddy route failed for opencode.sisihome.org" whenever the proxy was mid-restart, and the compact UI was unusable.

Replacing the binary in place with v1.17.13 (matching the DB schema) is the minimal hotfix. No code, spec, or deployment-surface change in opencode-remote itself — the proxy already supports `OPENCODE_CLI_PATH` and the new binary is the only thing the proxy needs.

## What Changes

- Replace `C:\Users\Kevin\AppData\Local\OpenCode\opencode-cli.exe` with the v1.17.13 binary that ships in the npm `opencode-ai@1.17.13` package (`C:\Program Files\nodejs\node_modules\opencode-ai\bin\opencode.exe`).
- Back up the broken 1.14.30 binary to `opencode-cli.exe.bak.1.14.30` for one-step rollback.
- Restart `opencode-remote` (the proxy on `127.0.0.1:9223`); the new upstream is auto-spawned on `127.0.0.1:4096` and the watchdog task `opencode-remote-watchdog` continues to self-heal every 5 minutes.
- User data (sessions, messages, project row, pins) is preserved because the DB schema was already 1.17.x-compatible.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
None.

This is a hotfix against an external dependency (opencode-cli), not a behavioral change to opencode-remote. No `specs/<name>/spec.md` delta is required.

## Impact

- **Affected code in this repo**: none (`packages/server/src/*` is unchanged; `dist/*` is build output, no rebuild needed for the hotfix itself).
- **Runtime dependency**: `opencode-cli` upgraded from 1.14.30 → 1.17.13. The proxy's `resolveOpenCodeCommand()` still resolves to `%LOCALAPPDATA%\opencode\opencode-cli.exe`, which is now the new binary. No `.env` change required; `OPENCODE_CLI_PATH` is not set.
- **External URL behavior**: unchanged. `https://opencode.sisihome.org` continues to route through desktop Caddy → `100.83.112.20:9223` → proxy → `127.0.0.1:4096`.
- **Sessions / data**: preserved. SQLite DB untouched, schema already matches 1.17.x, no migration tracking rows were inserted manually.
- **Watchdog**: no change to scheduled task. The `/remote-sessions` health check now returns 200 instead of 500, so the watchdog passes through.
- **Rollback**: copy `opencode-cli.exe.bak.1.14.30` back over `opencode-cli.exe`, then run `restart-service.ps1`. Will reintroduce the migration 500; only do this if 1.17.13 has a regression.
