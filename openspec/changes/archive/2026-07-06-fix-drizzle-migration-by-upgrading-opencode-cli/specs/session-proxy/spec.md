## ADDED Requirements

### Requirement: Proxy SHALL run against a compatible opencode-cli version
The session-proxy SHALL be deployed against an `opencode-cli` whose bundled Drizzle migrations match the schema of the existing `~/.local/share/opencode/opencode.db`. If the opencode-cli is older than the schema in the DB, the upstream `opencode serve` will fail to start and every proxy request that hits `/session`, `/health`, or `/event` will return HTTP 500 with `DrizzleError: table X already exists`.

#### Scenario: opencode-cli is older than the DB schema
- **WHEN** the opencode-remote proxy spawns `opencode serve` against an existing SQLite database
- **AND** the opencode-cli version is older than the schema version in the DB
- **THEN** the upstream `opencode serve` SHALL fail its Drizzle migration step on startup
- **AND** every request from the proxy to `http://127.0.0.1:$OPENCODE_PORT` SHALL return 500
- **AND** the proxy's `/remote-sessions` and `/remote-health` endpoints SHALL also return 500

#### Scenario: opencode-cli matches the DB schema
- **WHEN** the opencode-cli version is equal to or newer than the DB schema version
- **THEN** the upstream `opencode serve` SHALL complete Drizzle migrations successfully
- **AND** the proxy's `/remote-sessions` SHALL return 200 with the session list
- **AND** the watchdog's `Test-ProxyHealth` SHALL pass and the proxy SHALL NOT be restarted

#### Scenario: opencode-cli is in-place upgraded to fix a migration conflict
- **WHEN** the opencode-cli at `%LOCALAPPDATA%\opencode\opencode-cli.exe` is replaced with a newer version (e.g., 1.14.30 → 1.17.13) without changing any opencode-remote source code
- **THEN** the proxy SHALL continue to find the binary via `resolveOpenCodeCommand()` and spawn it on the next restart
- **AND** existing SQLite data (sessions, messages, project rows, pins) SHALL be preserved
- **AND** `OPENCODE_CLI_PATH` SHALL NOT need to be set in `.env`
