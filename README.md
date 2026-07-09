# opencode-remote

在 Windows 上將 [OpenCode](https://opencode.ai) headless server 透過透明 HTTP proxy 暴露給所有裝置。任何裝置打開 URL 都會自動進入同一個最近活躍的 session。

## 啟動

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

# Proxy 轉導
curl http://localhost:9223/
# 預期: 302 redirect 到 session URL
```

手機如果 OpenCode 原生側欄看不到工作階段列表，可開 `https://opencode.sisihome.org/remote-sessions` 使用手機友善列表。
要確認目前是否經過 opencode-remote proxy，可開 `https://opencode.sisihome.org/remote-health`。
手機打開 `/` 會導到 `opencode-remote` 手機工作階段列表，桌面則維持導到最近 active session。

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
OPENCODE_PORT=4096                              # OpenCode 內部 port
SESSION_REFRESH_INTERVAL_MS=30000              # Session 刷新間隔（ms）
OPENCODE_CLI_PATH=                              # 可選：非標準 opencode-cli.exe 路徑
```

缺本機設定時可直接跑 `./start-hidden.ps1`；啟動流程會自動建立/補齊 `.env`。需要手動輸入 GitHub token 時再跑 `./setup-capabilities.ps1`。

## 架構

```
瀏覽器 → proxy (port 9223) → opencode-cli.exe serve (port 4096, localhost only)
```

- `GET /` → 302 redirect 到最近 session 的 SPA URL
- 其他請求 → 透明 pipe（不修改內容）
- 每 30 秒刷新 active session
- Background SSE keep-alive 防止 OpenCode idle

外網存取：`https://opencode.sisihome.org`（透過 RPi Caddy + Tailscale）

## 詳細文件

- [OPERATIONS.md](./OPERATIONS.md) — 完整操作手冊、故障排除
- [CLAUDE.md](./CLAUDE.md) — 技術細節、架構決策（給 AI assistant 看）
- [docs/local-llm-provider-setup.md](./docs/local-llm-provider-setup.md) — 在 OpenCode 加入自架 local LLM provider（含 `baseURL` 少 `/v1` 的常見坑）

## OpenCode Capability Setup

- Run `.\setup-capabilities.ps1` when local `.env` or workspace wiring is missing.
- [docs/opencode-capability-setup.md](./docs/opencode-capability-setup.md) — manual workspace wiring for `opencode.json`, `AGENTS.md`, MCP, memory, and subagents
- [docs/superpowers/specs/2026-05-06-capability-alignment-design.md](./docs/superpowers/specs/2026-05-06-capability-alignment-design.md) — approved capability alignment design
- [openspec/changes/capability-alignment/](./openspec/changes/capability-alignment/) — formal OpenSpec change
