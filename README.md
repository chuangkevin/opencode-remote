# opencode-remote

在 Windows 或 macOS 上將 [OpenCode](https://opencode.ai) headless server 透過透明 HTTP proxy 提供給受信任裝置。根路徑會進入工作階段列表，`/latest` 會轉到最近活躍的 session。

## Windows 啟動

```powershell
cd D:\GitClone\_HomeProject\opencode-remote
.\start-hidden.ps1
```

服務在背景執行，不阻塞終端。AI agent（Claude Code task）可直接用 PowerShell tool 執行此指令。

`start-hidden.ps1` 是一鍵啟動：會自動準備本機 `.env`、同步 `opencode.json` / `AGENTS.md` / `.opencode\agents` 到 runtime root、移除 user-level Pencil MCP、build、安裝每 5 分鐘健康檢查 watchdog，然後啟動服務。
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
| Logs | `/Users/kevin/Library/Logs/opencode-remote/` |

The LaunchAgent runs `/Users/kevin/.local/share/opencode-remote/run-opencode-sara.sh` directly. That wrapper waits for the exact Tailscale IPv4, constructs a clean environment, and execs `/opt/homebrew/bin/node`; Node then starts `/opt/homebrew/bin/opencode` as its direct child.

This direct-FDA design is deployed. Repeated production installer runs verified clean restart, direct Node ownership, and removal of the superseded runtime launcher.

Prerequisites:

- Full Disk Access is granted to the actual Homebrew binaries `/opt/homebrew/Cellar/node/26.8.1/bin/node` and `/opt/homebrew/Cellar/opencode/1.18.20/libexec/lib/node_modules/opencode-ai/bin/opencode.exe`.
- The stable launcher paths `/opt/homebrew/bin/node` and `/opt/homebrew/bin/opencode`, Tailscale, and the workspace exist at the documented paths.
- After a Homebrew upgrade, resolve both stable paths again. A changed Cellar binary may require a new Full Disk Access grant and disposable direct LaunchAgent verification before redeployment.

The direct FDA path was proven with disposable LaunchAgents before this source change: `/opt/homebrew/bin/node` read `/Users/kevin/Documents/Projects` and exited 0 with `NODE_FDA_OK`; `/opt/homebrew/bin/opencode serve` used that WorkingDirectory and returned `{"healthy":true,"version":"1.18.20"}` on temporary loopback port `4296`. The probe jobs, listener, and files were removed afterward.

`deploy/macos/deploy-local.sh` runs `npm ci`, typecheck, and build; installs only runtime files plus the direct wrapper; uses exact `launchctl bootout/bootstrap/kickstart`; and refuses bootstrap if either exact listener remains after bootout. Its bounded success gate requires exact health JSON, a running launchctl PID equal to the exact `100.113.121.103:9223` Node listener PID, the exact fixed Node command, and the fixed OpenCode command as Node's direct child.

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
