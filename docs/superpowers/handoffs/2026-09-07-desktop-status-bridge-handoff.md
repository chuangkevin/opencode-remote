# macOS Desktop Status Bridge Handoff - 2026-09-07

## Problem

`/remote-sessions` previously polled `/session/status` through the transparent
proxy, so every request reached only the Remote-owned OpenCode server on
`127.0.0.1:4196`. OpenCode Desktop runs a separate authenticated sidecar on a
dynamic loopback port. A running Desktop tab could therefore appear idle in the
remote session picker.

## Architecture

```text
OpenCode Desktop startup
  -> global plugin validates Desktop client + loopback server URL + Basic Auth
  -> atomic local runtime file (directory 0700, file/temp 0600)
  -> one process-global timer refreshes updatedAt every 5 minutes

/remote-sessions browser
  -> GET /c/session-status?directory=<absolute-path>
  -> Node proxy allows only OPENCODE_DIRECTORY or descendants
  -> opens credential once with O_NOFOLLOW, then validates and reads that descriptor
  -> Promise.allSettled(
       Remote-owned OpenCode :4196 /session/status,
       Desktop dynamic loopback /session/status with Basic Auth
     )
  -> merge fulfilled status maps; busy wins duplicate session IDs in either direction
  -> 502 only when neither source succeeds
```

The connection file is
`~/.local/share/opencode-remote/desktop-connection.json`. It is local `0600`
runtime state, generated on OpenCode Desktop startup, refreshed every five
minutes while that process runs, and never sent to the browser or committed.
The server also requires a regular owner-only file no larger than 16 KiB, an
HTTP(S) loopback origin, nonempty credentials, an integer timestamp no older
than 15 minutes and no more than 60 seconds in the future, and a live PID. It
never includes credentials in responses or logs. Plugin runtime-file failures
are best-effort and cannot reject Desktop plugin initialization.

The status endpoint rejects sibling paths, `..` escapes, and unrelated absolute
paths. Recovered pinned sessions outside `OPENCODE_DIRECTORY` remain visible,
but their cards omit `data-session-directory`, make no forbidden request, and
show no running indicator.

## Deployment

`deploy/macos/deploy-local.sh` installs
`opencode-remote-desktop-bridge.js` into the existing
`~/.config/opencode/plugins/` directory with mode `0600`. It preserves all other
plugins and does not edit `opencode.json`.

The plugin is loaded at config time. OpenCode Desktop must be restarted after
installation before future startup refreshes can create the runtime connection
file. This source change does not perform that Desktop restart or deployment.

## Files

- `deploy/macos/opencode-remote-desktop-bridge.js`
- `deploy/macos/deploy-local.sh`
- `packages/server/src/compact/session-status.ts`
- `packages/server/src/index.ts`
- `packages/server/static/remote-sessions.js`
- `packages/server/test/desktop-status-bridge.test.js`
- `packages/server/test/desktop-session-status.test.js`
- `packages/server/test/macos-deploy-contract.test.js`
- `packages/server/test/remote-sessions-status.test.js`

Product version is `0.2.1`.
