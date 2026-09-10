# opencode-remote

在 Windows 或 macOS 上將 [OpenCode](https://opencode.ai) headless server 透過透明 HTTP proxy 提供給受信任裝置。根路徑會進入工作階段列表，`/latest` 會轉到最近活躍的 session。

## Windows 啟動

```powershell
cd D:\GitClone\_HomeProject\opencode-remote
.\start-hidden.ps1
```

服務在背景執行，不阻塞終端。AI agent（Claude Code task）可直接用 PowerShell tool 執行此指令。

`start-hidden.ps1` 是一鍵啟動：會自動準備本機 `.env`、同步 capability files、build、在 configured ports 啟動並通過 exact health/workspace probe，之後才安裝每 5 分鐘 watchdog、Desktop status bridge 與 hourly idle-only updater。第一次安裝 bridge 後需由使用者重啟一次 OpenCode Desktop；腳本不會自動重啟 Desktop。
GitHub MCP 需要 `GITHUB_TOKEN`；沒有 token 時會自動停用，避免啟動紅燈。

> **手動備用（需開終端機）：** `npm start`（前景模式，日誌直接顯示，Ctrl+C 停止）

## 確認服務正常

```powershell
# OpenCode 健康狀態
curl http://localhost:4096/global/health
# 預期: {"healthy":true,"version":"1.4.3"}

# Proxy 根路徑
curl http://localhost:9223/
# 預期: 302 redirect 到 /remote-sessions
```

Windows CLI 解析順序為：明確 `OPENCODE_CLI_PATH`、有效 managed pointer `%LOCALAPPDATA%\opencode-remote\cli\active.json`、legacy `%LOCALAPPDATA%\opencode\opencode-cli.exe`、PATH `opencode`。`active.json` 驗證失敗會 fail closed 並往後 fallback，不會執行越出 `%LOCALAPPDATA%\opencode-remote\cli\versions\<version>` 的 path。

## Windows CLI 自動更新

Scheduled Task `opencode-remote-updater` 在目前互動式使用者登入時及之後無限期每小時執行，hidden、`IgnoreNew`、最長 20 分鐘，不保存帳密。VBS runner 同步等待 updater 並回傳 exit code，讓重疊與執行上限套用到真正的 updater。它只在 Remote health/version 與固定 workspace probe 都吻合、strict status 所有已連線來源成功且沒有 `busy` 時更新。若獨立偵測到 Desktop 正在執行，status header 必須包含 `desktop`，否則 defer。`idle` 與 `retry` 不阻擋；request failure、unknown/malformed status 或 persistent block marker 都會 defer。

更新只使用 local pinned `npm install opencode-ai@<exact-version> --prefix <unique-stage> --no-save --package-lock=false`，不做 global install，也不刪舊版本。SemVer（含 prerelease）只有 npm latest 較新時才更新，絕不 downgrade；版本相同但尚無有效 managed pointer 時會安裝該 exact current version並建立初始 pointer。切換前的 staging/install/version/ACL failure只清理自己的stage並回傳nonzero。npm timeout使用exact PID的`taskkill /T /F`等待整棵process tree結束後才cleanup。

切換前，updater會先atomically寫非secret `%LOCALAPPDATA%\opencode-remote\update-transaction.json`，再建立含PID、token、timestamp的quiesce marker。每次啟動取得兩把mutex後會先recover journal：new pointer/runtime已通過exact version與probe就finalize；prior pointer/runtime仍健康代表中斷發生在切換前，只清transaction且不重啟；其餘狀態才還原prior pointer/absence、重啟並驗證old version、寫`update.blocked`。損壞journal只在current runtime驗證健康後解除quiesce並block待人工檢查；沒有journal的marker則在取得exclusive updater mutex、確認owner且超過bounded runtime後回收，避免crash造成永久503。Desktop永不由updater停止或重啟。

```powershell
# 安裝或修復 bridge + updater（目前服務必須先通過 health/probe）
.\deploy\windows\install-opencode-updater.ps1

# 手動執行同一個 idle-only check
.\deploy\windows\update-opencode-remote.ps1

# 狀態、log、blocked recovery
Get-ScheduledTask -TaskName opencode-remote-updater
Get-Content "$env:LOCALAPPDATA\opencode-remote\logs\opencode-remote-updater.log" -Tail 100
Test-Path "$env:LOCALAPPDATA\opencode-remote\update.blocked"
Get-Content "$env:LOCALAPPDATA\opencode-remote\update-transaction.json" -ErrorAction SilentlyContinue
```

若 `update.blocked` 存在，先以 legacy/previous CLI 手動恢復服務並確認 exact `/remote-health` 與 `.opencode-remote\remote-fda-probe.txt` 可由 `/file/content` 讀取，再重跑 installer；installer 只有在 current health/version/probe 成功後才清除 marker。Windows scripts 已在 macOS 以 Node contract tests 與可用 parser/static checks 驗證；Windows host 先前 offline/version-blocked，因此 Scheduled Task、ACL、process ownership、實際 update/restart/rollback 仍待 Windows runtime 驗證。

手機如果 OpenCode 原生側欄看不到工作階段列表，可開 `https://opencode.sisihome.org/remote-sessions` 使用手機友善列表。
要確認目前是否經過 opencode-remote proxy，可開 `https://opencode.sisihome.org/remote-health`。
所有裝置打開 `/` 都會導到 `/remote-sessions`；需要最近 active session 時使用 `/latest`。

## macOS LaunchAgent

核准的 macOS 目標是 `MBA-Kevin.local`：

| 項目 | 值 |
|---|---|
| HTTPS URL | `https://opencode-sara.sisihome.org` |
| Tailnet URL | `http://100.113.121.103:9223` |
| Proxy listener | `100.113.121.103:9223` |
| Child OpenCode | `127.0.0.1:4196` |
| Workspace | `/Users/kevin/Documents/Projects` |
| Runtime copy | `/Users/kevin/.local/share/opencode-remote` |
| LaunchAgent | `/Users/kevin/Library/LaunchAgents/io.interagent.opencode-sara.plist` |
| Updater LaunchAgent | `/Users/kevin/Library/LaunchAgents/io.interagent.opencode-sara-updater.plist` |
| Logs | `/Users/kevin/Library/Logs/opencode-remote/` |

The LaunchAgent runs `/Users/kevin/.local/share/opencode-remote/run-opencode-sara.sh` directly. That wrapper waits for the exact Tailscale IPv4, constructs a clean environment, and execs `/opt/homebrew/bin/node`; Node then starts `/opt/homebrew/bin/opencode` as its direct child.

This direct-FDA design is deployed. Repeated production installer runs verified clean restart, direct Node ownership, and removal of the superseded runtime launcher.

Prerequisites:

- Full Disk Access is granted to the actual binaries currently resolved by the stable Homebrew launchers. Discover the OpenCode binary with `node -p 'fs.realpathSync("/opt/homebrew/bin/opencode")'` instead of relying on a versioned internal path.
- The stable launcher paths `/opt/homebrew/bin/node` and `/opt/homebrew/bin/opencode`, Tailscale, and the workspace exist at the documented paths.
- After a Homebrew upgrade, resolve both stable paths again. A changed Cellar binary may require a new Full Disk Access grant and disposable direct LaunchAgent verification before redeployment.

Deployment writes the fixed non-secret probe `/Users/kevin/Documents/Projects/.opencode-remote/remote-fda-probe.txt` with mode `0644` while preserving the shared `.opencode-remote` directory. The final gate requires the newly launched OpenCode API, through the Remote proxy, to return that file as the exact `{type:"text",content:"..."}` response.

`deploy/macos/deploy-local.sh` runs `npm ci`, typecheck, and build; installs only runtime files plus the direct wrapper; uses exact `launchctl bootout/bootstrap/kickstart`; and refuses bootstrap if either exact listener remains after bootout. Its bounded success gate requires exact health JSON, the exact FDA probe response, a running launchctl PID equal to the exact `100.113.121.103:9223` Node listener PID, the exact fixed Node command, and the fixed OpenCode command as Node's direct child. Only after that gate passes does a manual deployment remove the updater block marker.

Only after that main gate passes, deployment installs the exact `io.interagent.opencode-sara-updater` LaunchAgent. It runs once at load and every hour. The updater is idle-only and uses strict session status: Remote must respond, and when a live Desktop credential exists Desktop must also respond; every available source must contain no `busy` session. A closed Desktop has no work to protect and does not prevent updating. The normal UI endpoint keeps its one-source fallback behavior. Status is checked before update detection and again after the updater atomically owns its quiesce marker and waits one second. During an actual update, new Remote prompt-creating POSTs receive `503` JSON with `Retry-After: 1`; abort, session creation, pins, and status remain available. The updater upgrades only the Homebrew `opencode` formula, preserves the old keg, restarts only the Remote LaunchAgent, never restarts Desktop, and accepts recovery only when the exact new health version and FDA probe both match. Any failure after upgrade starts writes a block marker, relinks only `/opt/homebrew/bin/opencode` to its recorded old target, restarts Remote, and verifies the old version plus FDA probe. Hourly runs defer while blocked; a successful manual `deploy-local.sh` clears the marker. A recovered update closes only its own Skynet window; rollback failure leaves that window to expire by TTL.

```bash
# Manual idle-only check/update
/Users/kevin/.local/share/opencode-remote/update-opencode-sara.sh

# Logs
tail -n 100 /Users/kevin/Library/Logs/opencode-remote/opencode-sara-updater.log
tail -n 100 /Users/kevin/Library/Logs/opencode-remote/opencode-sara-updater.error.log
```

```bash
./deploy/macos/deploy-local.sh
```

Run this command only during an authorized deployment. Repository implementation or build success does not mean the LaunchAgent is installed or running.

The runtime wrapper uses a clean environment and contains no application credentials. The macOS listener is intentionally pinned to the exact Tailscale IPv4. It has no Basic auth only because this is a trusted Tailnet boundary. Do not change it to `0.0.0.0`, add public tunnel exposure, or expose port `4196`. `https://opencode-sara.sisihome.org` uses the existing DNS-only wildcard and the sole GN100 Caddy; `https://opencode.sisihome.org` continues to route to the Windows `kevinhome` deployment.

## 停止

```powershell
.\stop.ps1
```

`stop.ps1` 會停用 watchdog，避免手動停止後被自動拉起。若只想測試自復原，可用 `.\stop.ps1 -KeepWatchdog` 後等下一次排程重啟。
watchdog 透過 `run-watchdog-hidden.vbs` 隱藏執行，不應每分鐘跳出 console 視窗。
停止只會作用於configured proxy port上`ExecutablePath`等於current `node.exe`且parsed argv精確包含本repo env-file/server entry的Node listener，以及parent PID、resolved CLI executable與完整serve argv都精確吻合的configured loopback child；不再依名稱或substring掃描，且永不停止Desktop。

## 設定（`.env`）

```env
OPENCODE_DIRECTORY=D:\GitClone\_HomeProject   # OpenCode 工作目錄
PORT=9223                                       # Proxy 對外 port
BIND_ADDRESS=0.0.0.0                            # Proxy bind；Windows default 不變
OPENCODE_PORT=4096                              # OpenCode 內部 port
SESSION_REFRESH_INTERVAL_MS=30000              # Session 刷新間隔（ms）
OPENCODE_CLI_PATH=                              # 可選：非標準 opencode-cli.exe 路徑
```

缺本機設定時可直接跑 `./start-hidden.ps1`；啟動流程會自動建立/補齊 `.env`。需要手動輸入 GitHub token 時再跑 `./setup-capabilities.ps1`。

## 架構

```
瀏覽器 → proxy (port 9223) → opencode serve (localhost-only child port)
```

- `GET /` → 302 redirect 到 `/remote-sessions`
- `GET /latest` → 302 redirect 到最近 session 的 SPA URL
- 其他請求 → 透明 pipe（不修改內容）
- 每 30 秒刷新 active session
- Background SSE keep-alive 防止 OpenCode idle

Windows 私有網域：`https://opencode.sisihome.org`。macOS 私有網域：`https://opencode-sara.sisihome.org`。兩者都透過目前的 GN100 Caddy + Tailscale；macOS 也可直接使用 Tailnet URL `http://100.113.121.103:9223`。

## 詳細文件

- [OPERATIONS.md](./OPERATIONS.md) — 完整操作手冊、故障排除
- [CLAUDE.md](./CLAUDE.md) — 技術細節、架構決策（給 AI assistant 看）
- [docs/local-llm-provider-setup.md](./docs/local-llm-provider-setup.md) — 在 OpenCode 加入自架 local LLM provider（含 `baseURL` 少 `/v1` 的常見坑）

## OpenCode Capability Setup

- Run `.\setup-capabilities.ps1` when local `.env` or workspace wiring is missing.
- [docs/opencode-capability-setup.md](./docs/opencode-capability-setup.md) — manual workspace wiring for `opencode.json`, `AGENTS.md`, MCP, memory, and subagents
- [docs/superpowers/specs/2026-05-06-capability-alignment-design.md](./docs/superpowers/specs/2026-05-06-capability-alignment-design.md) — approved capability alignment design
- [openspec/changes/capability-alignment/](./openspec/changes/capability-alignment/) — formal OpenSpec change
