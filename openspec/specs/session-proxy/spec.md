# session-proxy

Transparent HTTP proxy in front of `opencode serve`. Its only job beyond
pipe-through is to redirect `GET /` to the currently-active session so every
device and every browser lands on the same conversation.

## Requirements

### SHALL spawn `opencode serve` as a child process

On startup, the proxy SHALL spawn `opencode serve --hostname 127.0.0.1 --port <OPENCODE_PORT>` with the working directory set to `OPENCODE_DIRECTORY`.

- On Windows, `opencode` is `opencode.cmd`, so the spawn MUST use `shell: true`.
- If the spawn fails with `EADDRINUSE` **and** `GET /global/health` already returns `{ healthy: true }`, the proxy SHALL continue using the existing OpenCode instance instead of exiting. This lets development work when OpenCode is already running.

### SHALL wait for OpenCode to be healthy before accepting traffic

The proxy SHALL poll `GET /global/health` for up to 60 seconds. If OpenCode does not become healthy, the proxy SHALL exit with a non-zero status.

### SHALL redirect `GET /` to the active session URL

The active session URL SHALL have the format `/<base64url(session.directory)>/session/<session.id>`, where `base64url` is standard base64 with `+`/`/` replaced by `-`/`_` and no `=` padding.

- If no session has been resolved yet (startup in progress), the proxy SHALL respond with 503 and a human-readable body.
- Redirects SHALL use HTTP 302 with the `Location` header.

### SHALL resolve the active session by directory match first

Every 30 seconds (configurable via `SESSION_REFRESH_INTERVAL_MS`), the proxy SHALL call `GET /session` and pick:

1. The session whose `directory === OPENCODE_DIRECTORY`, most-recently-updated first
2. Otherwise, the globally most-recently-updated session
3. Otherwise, a newly created session via `POST /session { title: "opencode-remote" }`

The first case is preferred because the configured directory is guaranteed clean; some legacy sessions have non-UTF-8 bytes in `directory` that break the base64url URL.

### SHALL proxy all non-`/` requests transparently to OpenCode

For every request other than `GET /`, the proxy SHALL pipe the request body to `http://127.0.0.1:<OPENCODE_PORT>` and stream the response back. SSE responses MUST NOT be buffered — `proxyRes.pipe(res)` is sufficient.

On upstream connection failure, the proxy SHALL respond with 502 if headers have not been sent yet.

### SHALL maintain a background SSE keep-alive to OpenCode

The proxy SHALL open a long-lived `GET /event` connection to OpenCode using `Accept: text/event-stream` and simply drain its output. This prevents OpenCode from idling when no browser is connected.

Reconnect logic MUST use exponential backoff capped at 30 seconds, resetting to 1 second on successful connection.

### SHALL read configuration from environment variables

| Variable | Default | Purpose |
|---|---|---|
| `OPENCODE_DIRECTORY` | `process.cwd()` | Working directory for `opencode serve`; also the session filter key |
| `PORT` | `9223` | Port the proxy listens on |
| `OPENCODE_PORT` | `4096` | Port the child `opencode serve` binds to |
| `SESSION_REFRESH_INTERVAL_MS` | `30000` | How often to re-query the active session |

Configuration SHALL be loaded from `.env` via Node's `--env-file` flag (set in `package.json` scripts). No `dotenv` runtime dependency.
