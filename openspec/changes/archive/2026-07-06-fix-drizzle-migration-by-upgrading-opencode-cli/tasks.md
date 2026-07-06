# Tasks: opencode-cli hotfix

> All tasks were completed in the initial response because the service was reported as "completely unusable". The change is being recorded retroactively. Every task below is checked.

## 1. Stop opencode-remote cleanly

- [x] 1.1 Run `stop.ps1` elevated to disable `opencode-remote-watchdog` and kill `node`/`opencode-cli` listeners on ports 9223, 9224, and 4096.
- [x] 1.2 Verify no listeners remain on the three ports.

## 2. Replace opencode-cli binary

- [x] 2.1 Locate the new binary at `C:\Program Files\nodejs\node_modules\opencode-ai\bin\opencode.exe` (npm `opencode-ai@1.17.13`).
- [x] 2.2 Back up `%LOCALAPPDATA%\opencode\opencode-cli.exe` to `opencode-cli.exe.bak.1.14.30`.
- [x] 2.3 Copy the new binary over `%LOCALAPPDATA%\opencode\opencode-cli.exe`.
- [x] 2.4 Run `opencode-cli.exe --version` to confirm `1.17.13`.

## 3. Restart and verify

- [x] 3.1 Re-enable the `opencode-remote-watchdog` scheduled task.
- [x] 3.2 Launch `start.ps1 -NoPrepare` elevated in a hidden window.
- [x] 3.3 Verify `0.0.0.0:9223` (proxy) and `127.0.0.1:4096` (upstream) are listening.
- [x] 3.4 Verify `http://127.0.0.1:4096/session` returns 200 with the existing session list.
- [x] 3.5 Verify `http://127.0.0.1:9223/remote-health` reports `version: 1.17.13` and `upstreamHealth.healthy: true`.
- [x] 3.6 Verify `http://127.0.0.1:9223/remote-sessions` returns 200.
- [x] 3.7 Verify `https://opencode.sisihome.org/remote-health` and `https://opencode.sisihome.org/remote-sessions` both return 200 (desktop Caddy route intact).
- [x] 3.8 Verify the previous session `ses_0c96f7f79ffe5Ca7IuOHVEQqUy` is still listed.

## 4. Cleanup

- [x] 4.1 Kill the orphan `node` listener on port 9224 (residual from a manual `npm start` that did not go through `start.ps1`).
- [x] 4.2 Delete the misplaced `D:\GitClone\_HomeProject\openspec\changes\upgrade-opencode-cli-fix-migration` change that was created by accident in the wrong openspec project.
- [x] 4.3 Delete the `D:\GitClone\_HomeProject\opencode-remote\openspec\changes\test-loc` change used to verify openspec CLI workdir behavior.
- [x] 4.4 Confirm the watchdog log stops recording `Service unhealthy; restarting` entries.

## Open items (not blocking this change, flagged for Kevin)

- The same upgrade is also relevant to any other HomeProject consumer that uses the `opencode` binary on PATH directly (e.g., a future homelab-docs change may want to codify "all consumers must use `%LOCALAPPDATA%\opencode\opencode-cli.exe` as the canonical opencode-cli path"). This is out of scope for the proxy hotfix.
- The `C:\Program Files\nodejs\node_modules\opencode-ai` npm package will continue to drift with future `npm install -g` operations. If 1.17.13 is upgraded later via `opencode upgrade --method npm` while the in-place binary is left at 1.17.13, the proxy and the npm package will diverge. Future maintenance: either re-run the in-place replace, or set `OPENCODE_CLI_PATH` via `setup-capabilities.ps1` once it is enhanced to honor an explicit override.
