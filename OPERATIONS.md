# OpenCode Remote - 操作手冊

## 快速啟動

### 啟動服務

**背景啟動（主要方式）：**

```powershell
cd D:\GitClone\_HomeProject\opencode-remote
.\start-hidden.ps1
```

服務在背景執行，不阻塞終端。**AI agent（Claude Code task）可直接透過 PowerShell tool 執行此指令。**

`start-hidden.ps1` 是一鍵啟動：會自動準備 `.env`、同步 capability config 到 `OPENCODE_DIRECTORY`、移除 user-level Pencil MCP、執行 build、安裝每 5 分鐘執行一次的 watchdog scheduled task，然後啟動服務。

- 本地訪問: http://localhost:9223
- 外網訪問: https://opencode.sisihome.org

> **手動備用（需使用者開終端機）：** `./start.ps1`
> 前景模式，會做同樣的一鍵準備流程，日誌直接顯示，Ctrl+C 停止。
> AI agent 無法使用這個方式（阻塞式進程，且 terminal 只有 click 權限無法輸入）。

### 確認服務正常

啟動後約 10 秒，執行以下 health check：

```powershell
# 1. 確認 proxy 健康（最可靠 — 內含 upstream 檢查）
curl http://localhost:9223/remote-health
# 預期：{"proxy":"opencode-remote","remotePort":9223,"upstream":"http://127.0.0.1:4196","upstreamHealth":{"healthy":true,...}}

# 2. 確認 proxy 正常轉導
curl http://localhost:9223/
# 預期：302 redirect 到 session URL
```

兩個都正常就代表服務完全就緒。

> **Port 提醒**：本機 OpenCode CLI 預設用 **4196**（不是 4096），因為 4096 已被
> 本 repo 的 `docker-compose.yml` 容器占用。`.env` 的 `OPENCODE_PORT` 控制；
> 直接打 `http://localhost:4196/global/health` 可以驗證 upstream。詳見「故障排除 / Docker 容器跟 OpenCode 搶 port」。

### 手機工作階段列表

OpenCode 原生 mobile layout 可能只顯示目前 session，不顯示完整工作階段列表。手機可直接開：

```text
https://opencode.sisihome.org/remote-sessions
```

這是 `opencode-remote` 提供的輕量 session picker，點選任一項會進入對應 OpenCode session。
手機 User-Agent 打開 `/` 時，`opencode-remote` 會導到 `/remote-sessions`，避免 OpenCode 原生 mobile layout 看不到工作階段列表。

### 確認手機走 opencode-remote

```text
https://opencode.sisihome.org/remote-health
```

回應中的 `proxy` 應為 `opencode-remote`，`remotePort` 應為 `9223`。

### 重新啟動服務

```powershell
cd D:\GitClone\_HomeProject\opencode-remote
.\restart-service.ps1
```

或手動重啟：

```powershell
.\stop.ps1
sleep 2
.\start-hidden.ps1
```

### 停止服務

```powershell
cd D:\GitClone\_HomeProject\opencode-remote
.\stop.ps1
```

`stop.ps1` 會同時停止 proxy (port 9223) 和 OpenCode (port 從 `.env` `OPENCODE_PORT` 讀，預設 4196)。
殺 process 前有 **process-name allowlist 防呆** — 只殺 `node` / `opencode-cli` / `opencode`，碰到其他持有者（例如 Docker vpnkit）會 log `skipping` 跳過。
預設也會停用 `opencode-remote-watchdog`，避免手動停止後被自動拉起。若要測試自動重啟，使用 `.\stop.ps1 -KeepWatchdog`。

### 自動重啟 watchdog

`start-hidden.ps1` 會安裝 Windows Scheduled Task：`opencode-remote-watchdog`。

```powershell
# 手動安裝或更新 watchdog
.\install-watchdog.ps1

# 立即跑一次健康檢查與自復原
.\ensure-service.ps1

# 查看 watchdog 狀態
Get-ScheduledTask -TaskName opencode-remote-watchdog
```

watchdog 每 5 分鐘檢查：

- `http://127.0.0.1:9223/remote-health` 必須回 `200` 且 `upstreamHealth.healthy === true`
- `http://127.0.0.1:9223/remote-sessions` 必須回 `200`

任一檢查失敗時，會用 `start.ps1 -NoPrepare` 在背景重啟服務。紀錄寫入 `opencode-remote-watchdog.log`。
排程透過 `run-watchdog-hidden.vbs` 啟動隱藏 PowerShell，不應跳出 console 視窗。

> **歷史地雷（2026-05-21 已修）**：舊版 `start.ps1` 用 `netstat | Select-String ":<port>.*LISTENING"`
> 做字串比對，`:4096` 在字串中能 match `:40961` / `:14096` 等 — Docker Desktop 的
> 高位 ephemeral port 撞到就被當作 opencode 殺掉，每 5 分鐘觸發一次 Docker crash。
> 修法：改用 `Get-NetTCPConnection -LocalPort <int>` + process-name allowlist。詳見「故障排除」。

如果需要用 PID 手動停止（例如 start-hidden.ps1 輸出的 PID）：

```powershell
taskkill /F /PID <PID>
```

## 檢查服務狀態

### 完整 Health Check

```powershell
# 推薦：打 proxy 的 remote-health，內含 upstream 檢查
curl http://localhost:9223/remote-health
# 預期: {"proxy":"opencode-remote","upstream":"http://127.0.0.1:4196","upstreamHealth":{"healthy":true,...}}

# 直接打 opencode-cli（OPENCODE_PORT 從 .env 讀；預設 4196）
curl http://localhost:4196/global/health
# 預期: {"healthy":true,"version":"1.x.x"}

# Proxy 根路徑（轉導測試）
curl http://localhost:9223/
# 預期: 302 redirect 到 /<base64(dir)>/session/<id> 或 /remote-sessions

# Compact UI 三個關鍵端點
curl -o /dev/null -w "%{http_code}\n" http://localhost:9223/remote-sessions
curl -o /dev/null -w "%{http_code}\n" http://localhost:9223/c/static/compact.js
curl http://localhost:9223/c/pins
# 預期: 200 / 200 / JSON 陣列（已釘選的 sessionID）

# OpenCode instance config（確認 MCP 不是只載到 user-level config）
curl http://localhost:4196/config
# 預期: mcp 包含 filesystem / git / fetch connected；github 無 token 時 disabled；不包含 pencil

# MCP 狀態摘要
opencode mcp list
# 預期: filesystem / git / fetch connected；github disabled 或 connected；playwright disabled

# 外網訪問（需要 Tailscale 和 Caddy 正常）
curl -L https://opencode.sisihome.org/
# 預期: 完整 HTML
```

### 檢查端口是否在監聽

```powershell
# 用 NUMERIC 比對，不要用 netstat | findstr 字串
Get-NetTCPConnection -LocalPort 9223 -State Listen   # proxy (node)
Get-NetTCPConnection -LocalPort 4196 -State Listen   # OpenCode CLI（或 .env 設的 port）

# 確認持有者名字
Get-NetTCPConnection -LocalPort 9223 -State Listen | ForEach-Object {
    Get-Process -Id $_.OwningProcess | Select-Object Id, ProcessName
}
```

兩個端口都應有持有者，名字應為 `node`（9223）和 `opencode-cli`（4196）。

## 修改代碼後的流程

以下步驟 AI agent 可以全部透過 PowerShell/Bash tool 執行：

```powershell
# 1. 修改代碼 (packages/server/src/*.ts)  ← AI 用 Edit tool

# 2. 編譯（非阻塞，等完成後返回）
npm run build

# 3. 重啟服務（背景，不阻塞）
.\restart-service.ps1

# 4. 驗證
curl http://localhost:9223/
```

## 故障排除

### 問題: 502 Bad Gateway

**原因:** 服務未啟動或 OpenCode 未就緒

**解決:**
```powershell
.\restart-service.ps1
sleep 10
curl http://localhost:4096/global/health
```

### 問題: Port 已被占用

**原因:** 之前的進程未正確關閉，或別的服務在用我們的 port

**解決:**
```powershell
# 用 NUMERIC port 比對找出真正持有者（不要用 netstat | findstr 字串）
Get-NetTCPConnection -LocalPort 9223 -State Listen | ForEach-Object {
    Get-Process -Id $_.OwningProcess | Select-Object Id, ProcessName, Path
}
Get-NetTCPConnection -LocalPort 4196 -State Listen | ForEach-Object {
    Get-Process -Id $_.OwningProcess | Select-Object Id, ProcessName, Path
}

# 只有當 ProcessName 是 node / opencode-cli / opencode 才能殺
# 如果是其他 (例如 com.docker.backend, vpnkit, wslrelay) 千萬不要殺 — 那是 Docker
Stop-Process -Id <PID> -Force

# 或乾脆走 stop.ps1，它已內建 allowlist 防呆
.\stop.ps1
.\start-hidden.ps1
```

### 問題: Docker 容器跟 OpenCode 搶 port

**症狀:** `start-hidden.ps1` 失敗、`/remote-health` 回 502、Docker 容器無法 bind 4096，或 Docker Desktop 反覆 crash。

**原因:** 本 repo 的 `docker-compose.yml` 在 `0.0.0.0:4096->4096/tcp` publish port，跟 OpenCode CLI 預設 4096 衝突。

**解決:**
```powershell
# 確認衝突方
Get-NetTCPConnection -LocalPort 4096 -State Listen | ForEach-Object {
    Get-Process -Id $_.OwningProcess | Select-Object Id, ProcessName
}
# 同時看到 com.docker.backend + opencode-cli 兩個就代表撞了

# 解法 A（已採用）：本機 opencode-cli 改用 4196
# 編輯 .env，把 OPENCODE_PORT 改成 4196，然後重啟
.\stop.ps1
.\start-hidden.ps1

# 解法 B：不跑 docker compose
docker compose down
```

### 問題: Watchdog 每幾分鐘觸發重啟（或 Docker 反覆 crash）

**症狀:** `opencode-remote-watchdog.log` 一直出現 `Service unhealthy; restarting`，或 Docker Desktop 反覆重啟，crash 時間幾乎全部對齊 watchdog log 條目。

**歷史 root cause（2026-05-21 已修）:**
1. `start.ps1` / `stop.ps1` 用 `netstat | Select-String ":<port>.*LISTENING"` 字串比對 — `:4096` 在字串裡能 match `:40961` / `:14096`，誤殺 Docker 的高位 ephemeral port
2. 本 repo `docker-compose.yml` 跟 opencode-cli 搶 host 4096 — 即使 numeric 比對也會精準殺到 Docker vpnkit

**現在的防禦（兩層）:**
- `Get-NetTCPConnection -LocalPort <int>` (numeric, 不會 substring 誤中)
- process-name allowlist (只殺 `node` / `opencode-cli` / `opencode`，碰到其他 log skipping 跳過)

**檢查方式:**
```powershell
# Watchdog 排程狀態
Get-ScheduledTask -TaskName 'opencode-remote-watchdog' | Get-ScheduledTaskInfo

# 最近 watchdog log
Get-Content opencode-remote-watchdog.log -Tail 10

# 殺 port 時是否有 allowlist 訊息
.\stop.ps1
# 看 output 是否有 "skipping — not an opencode process" 表示有別人占用
```

**緊急停用 watchdog（不再自動重啟）:**
```powershell
Disable-ScheduledTask -TaskName 'opencode-remote-watchdog'
# 或
.\stop.ps1   # 預設會 disable watchdog
```

### 問題: OpenCode 立即退出 (exit code 0 或 1)

**原因:** 錯誤的 OpenCode 執行檔或使用者專屬路徑寫死

**檢查:** 服務必須使用 CLI 版 `opencode-cli.exe`，不能啟動 GUI 版 `OpenCode.exe`。

```powershell
# 預設尋找這台電腦目前使用者的 CLI
Test-Path "$env:LOCALAPPDATA\opencode\opencode-cli.exe"

# 若安裝在非標準位置，寫到本機 .env，不要改 source code
OPENCODE_CLI_PATH=C:\path\to\opencode-cli.exe
```

**不能使用:** `OpenCode.exe` (GUI 版本，會立即退出)
**必須使用:** `opencode-cli.exe` (CLI 版本)。`opencode-remote` 會依序使用 `OPENCODE_CLI_PATH`、`%LOCALAPPDATA%\opencode\opencode-cli.exe`、最後 fallback `opencode`。

### 問題: HTTPS 外網無法訪問

**檢查步驟:**

1. **本地訪問是否正常:**
   ```powershell
   curl http://localhost:9223/
   ```

2. **RPi Caddy 是否正常:**
   - SSH 到 RPi
   - 檢查 Caddy logs
   - 確認 Caddyfile 有 opencode.sisihome.org 配置

3. **Tailscale 連接是否正常:**
   ```powershell
   curl http://100.83.112.20:9223/
   ```

### 問題: 頁面載入但無內容

**原因:** 前端資源載入失敗或 session 過期

**解決:**
1. 清除瀏覽器 cache
2. 重新訪問 https://opencode.sisihome.org/
3. 檢查 session 是否有效：
   ```powershell
   curl http://localhost:4096/global/health
   ```

## 環境變數（`.env`）

服務從 `.env` 自動載入設定（`npm start` / `npm run dev` 已設定 `--env-file`）：

```env
# OpenCode 工作目錄 — 決定要顯示哪個目錄的 sessions（建議用正斜線）
OPENCODE_DIRECTORY=D:/Projects/_HomeProject

# Proxy 對外 port（瀏覽器訪問的 port）
PORT=9223

# OpenCode 內部 port（僅 localhost）
# 4096 已被本 repo docker-compose.yml 占用 → 改用 4196 避開
OPENCODE_PORT=4196

# Session 刷新間隔（毫秒）— 多久重新抓最新 session
SESSION_REFRESH_INTERVAL_MS=30000
```

修改 `.env` 後需重啟服務才生效。若 `.env` 不存在，複製 `.env.example` 建立：

```powershell
Copy-Item .env.example .env
# 然後修改 OPENCODE_DIRECTORY 為你的實際路徑
```

## 注意事項

### ⚠️ 不要手動運行 opencode serve

OpenCode server 會由 opencode-remote 自動啟動。不要手動運行 `opencode serve`，否則端口會衝突。

### ⚠️ 環境變量設置

OpenCode server 必須設置 `OPENCODE_SERVER_PASSWORD=""` 來禁用認證。這已經在代碼中處理 (index.ts line 154)。

### ⚠️ HTML 修改已禁用

為了 Caddy 兼容性，已禁用 HTML 內容修改（包括 auto-reload script 注入）。
服務現在是純透傳代理，不會修改任何響應內容。

## 性能監控

### 檢查內存使用

```powershell
# 找到進程 ID
$pid = (netstat -ano | findstr :9223 | Select-String "LISTENING").ToString().Split()[-1]

# 查看內存使用
Get-Process -Id $pid | Select-Object ProcessName, @{Name="Memory(MB)";Expression={[math]::Round($_.WorkingSet / 1MB, 2)}}
```

### 查看服務日誌

`start-hidden.ps1` 的輸出會到背景（無法直接查看）。要查看即時日誌需手動操作：

```powershell
# 停止目前服務
.\stop.ps1

# 手動開 PowerShell 終端機，前台模式啟動
npm start
# （Ctrl+C 停止）
```

> **注意：** 此操作需要使用者手動在終端機執行，AI agent 無法代為操作。

## 自動化測試

### Playwright 測試

```powershell
cd D:\GitClone\_HomeProject\opencode-remote
node test-screenshot2.mjs
```

成功會生成 `opencode-screen.png` 截圖。

### 簡單健康檢查腳本

```powershell
# health-check.ps1
$response = curl -s http://localhost:9223/
if ($response -match "302") {
    Write-Host "✅ Service is healthy" -ForegroundColor Green
} else {
    Write-Host "❌ Service is down" -ForegroundColor Red
    exit 1
}
```

## 架構圖

```
用戶瀏覽器
    ↓ HTTPS
opencode.sisihome.org (DNS: 100.126.226.79)
    ↓ Tailscale
RPi Caddy (100.79.242.43:443)
    ↓ HTTP Reverse Proxy
Windows opencode-remote (100.83.112.20:9223)            ← node proxy
    ↓ HTTP Proxy
OpenCode Server (127.0.0.1:4196)                         ← opencode-cli
    ↓ 文件系統
D:\Projects\_HomeProject

(Docker compose 容器另外跑在 4096:4096，跟 opencode-cli 各走各的)
```

## Compact UI（手機 / 小螢幕用）

OpenCode 原生 SPA 在手機橫向 / 雙螢幕不可用，因此提供獨立 compact frontend。

**進入點：**
- `https://opencode.sisihome.org/remote-sessions` — session 列表（有 📌 釘選、Compact pill）
- 點 Compact pill → `/c/session/:id` — 精簡對話 UI

**功能（按主題）：**
| 主題 | 行為 |
|---|---|
| 對話 | Markdown 渲染 / 圖片附件 / fire-and-forget 送出 |
| 串流 | SSE live update / sticky scroll / 三點脈動「思考中」/ optimistic user message |
| Stop / Queue | streaming 時：紅色 ■ stop 中止 AI；▶ send 變排隊（localStorage 持久化，跨 reload）|
| AI 提問 | `question.asked` 卡片 + 選項按鈕（單選自動送、多選有送出/略過）|
| 權限 | `permission.asked` 自動 allow（trust mode + always-on 兜底）|
| Session 管理 | 標題 inline 編輯 / ⋯ menu (釘選 / 新建 / 原生 SPA / 刪除) |
| 釘選 | 跨重啟 + 跨裝置（檔案：`<OPENCODE_DIRECTORY>/.opencode-remote/pins.json`）|
| 模型 | 點 header chip 開 picker（provider × model × variant）|

**詳細：** 見 `CLAUDE.md` 的「Compact UI」章節。

## 相關文件

- `CLAUDE.md` - 專案詳細文檔和開發歷史
- `README.md` - 專案基本說明
- `packages/server/src/index.ts` - 主程序源碼
- `.env` - 環境變量配置

## 更新歷史

### 2026-05-21
- **Watchdog 殺 Docker 兇案修復**：`start.ps1` / `stop.ps1` 殺 process 改用 `Get-NetTCPConnection -LocalPort <int>` (numeric port) + process-name allowlist (`node` / `opencode-cli` / `opencode`)。歷史上 substring 比對誤殺 Docker 的高位 ephemeral port，每 5 分鐘 watchdog tick → Docker crash
- **OPENCODE_PORT 預設改 4196**：避開 `docker-compose.yml` 容器佔用的 4096
- **Compact UI Phase 2**：AI question UI / permission auto-accept / optimistic user message / thinking indicator / ⋯ overflow menu / pin sessions / prompt queue / auto-title fix
- Commits：`6b46836` `1441227` `cd4a2c6` `aac28a4` `a2dacf2` `93db006` `4acc2ca` `0f62ecf`

### 2026-04-22
- 禁用 HTML 修改功能以解決 Caddy HTTPS 兼容性問題
- 移除 VISIBILITY_SCRIPT 注入邏輯
- 改為純透傳代理模式
- 修復：Transfer-Encoding: chunked 導致的連接關閉問題
