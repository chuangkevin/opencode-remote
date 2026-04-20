# opencode-remote — AI Assistant Context

## 專案目的

在 Windows 電腦上運行 OpenCode headless server，並透過一個透明 HTTP proxy 將 OpenCode 的原生 Web UI 暴露給所有裝置。任何裝置打開 URL 都會自動進入同一個最近活躍的 session，看到完整對話歷史，可以繼續工作。Session 在伺服器端持久化，瀏覽器關閉不影響。

## 架構

```
瀏覽器 → proxy (port 9223) → opencode serve (port 4096, localhost only)
```

`packages/server/src/index.ts` — proxy 主程式：
- `GET /` → 302 redirect 到最近 session 的完整 SPA URL
- 其他所有請求 → 透明 pipe 到 OpenCode
- Background SSE keep-alive 防止 OpenCode idle
- 每 30 秒 refresh active session path

`packages/server/src/session.ts` — session 解析：
- 呼叫 `GET /session` 列出所有 sessions
- 依 `OPENCODE_DIRECTORY` 過濾，取 `time.updated` 最新的
- 若無符合 directory 的 session，fallback 到全域最新
- 只在完全沒有 session 時才 `POST /session` 新建

`packages/server/src/config.ts` — 設定（從環境變數讀取）

## 關鍵技術細節

### OpenCode SPA URL 格式

OpenCode SPA 的 router 路由是 `/:dir/session/:id?`，其中：
- `:dir` = **`base64url(session.directory)`**（UTF-8 編碼的目錄路徑，不含 `=` padding）
- `:id` = session ID（格式 `ses_xxxxx`）

**正確範例：**
```
D:\Projects\_HomeProject
  → base64url → RDpcUHJvamVjdHNcX0hvbWVQcm9qZWN0
  → URL: /RDpcUHJvamVjdHNcX0hvbWVQcm9qZWN0/session/ses_2661d25a0ffeTMVY2KwFgK5Ifz
```

**錯誤做法：** 不能用 `/global/session/<id>` 或 `/<session-slug>`。
- `/global/session/<id>` — SPA 會自己跳轉到用 session 存儲的 directory 編碼的 URL，但如果該 directory 含有亂碼 bytes（Windows 編碼問題），會產生格式錯誤的 URL，導致空白頁
- `/<session-slug>` — SPA 把 slug 當成 workspace 識別符，不是 session，會打開一個新空白 session

**`encodeDirSlug()` 實作（`session.ts`）：**
```typescript
function encodeDirSlug(dir: string): string {
  return Buffer.from(dir, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
```

### OpenCode Session API

```
GET  /session                    → OpenCodeSession[]
POST /session { title }          → OpenCodeSession  (新建)
GET  /session/<id>               → OpenCodeSession  (需用 ses_xxx id，不是 slug)
GET  /global/health              → { healthy: boolean }
GET  /project                    → Project[]  (含 worktree 路徑)
GET  /event                      → SSE stream
```

`OpenCodeSession` 結構：
```typescript
{
  id: string;          // "ses_2661d25a0ffeTMVY2KwFgK5Ifz"
  slug: string;        // "glowing-sailor" (人類可讀，不用於URL)
  projectID: string;   // 通常是 "global"
  directory: string;   // 實際工作目錄路徑（可能含亂碼，見注意事項）
  title: string;
  time: { created: number; updated: number };
}
```

### Windows 特有問題

**opencode.cmd spawn：** Windows 上 `opencode` npm global 安裝為 `opencode.cmd`，spawn 時需要 `shell: process.platform === "win32"` 才能找到。

**Directory 亂碼：** 某些舊 session 的 `directory` 欄位含有非 UTF-8 bytes（Windows 路徑編碼問題）。URL 必須用 session 自己的 `directory` 編碼（才能對應 SPA 內部 workspace context），所以亂碼 session 產生的 URL 無法使用。解法是優先挑選 `directory === OPENCODE_DIRECTORY` 的 session，這樣被編碼的就是乾淨的設定路徑。

**EADDRINUSE：** 開發時 OpenCode 可能已在 port 4096 運行。proxy 的 spawn 會失敗，但 `oc.on("exit")` handler 會檢查 OpenCode 是否已經健康，若是則不 crash。

## 設定（`.env`）

```env
OPENCODE_DIRECTORY=D:\Projects\_HomeProject   # OpenCode 工作目錄
PORT=9223                                       # proxy 對外 port
OPENCODE_PORT=4096                              # OpenCode 內部 port
SESSION_REFRESH_INTERVAL_MS=30000              # session 刷新間隔
```

`.env` 檔案由 `--env-file` 從 root 載入（`npm start` / `npm run dev` 已設定）。

## 啟動方式

**開發：** `npm run dev`（tsx watch，自動重載）
**生產：** `npm start` 或直接點 `start.ps1`
**Docker：** `docker compose up`（需設 `WORKSPACE_PATH` 環境變數）

## Docker

- Builder: `node:22-bookworm`，production: `node:22-bookworm-slim`
- `npm install -g opencode` 安裝 OpenCode CLI
- Volume `opencode_data:/root/.opencode` 持久化 session 資料
- Bind mount `${WORKSPACE_PATH}:/workspace` 讓 OpenCode 存取工作目錄
- Healthcheck: `GET /global/health`

## OpenSpec（規格來源）

本專案使用 OpenSpec 管理規格。主要檔案：

- `openspec/config.yaml` — 專案上下文（已更新為 transparent proxy 架構）
- `openspec/specs/session-proxy/spec.md` — **目前唯一的 capability spec**，完整定義 proxy 的行為要求（啟動、health check、redirect 格式、session 解析、keep-alive、配置）
- `openspec/changes/deployment-wiring/` — **待執行的變更**：RPi Caddy entry + kevinhome 開機自啟
- `openspec/changes/archive/` — 已被取代的舊設計（Dispatch 模型，勿接手）

後續接手時：
1. 讀 `session-proxy/spec.md` 了解 proxy 必須做到什麼
2. 讀 `changes/deployment-wiring/tasks.md` 知道還有什麼沒做
3. 改東西前確認新行為符合 spec；若要改行為，先在 `openspec/changes/<name>/` 開新提案

## 目前進度與後續工作

### 已完成
- [x] 透明 HTTP proxy（`node:http` pipe，SSE 支援）
- [x] `GET /` → 302 → `/<base64url(dir)>/session/<sessionId>`
- [x] 每 30 秒刷新 active session path
- [x] Background SSE keep-alive（指數退避重連）
- [x] `waitForOpenCode()` 健康檢查（60 秒超時）
- [x] Windows `opencode.cmd` spawn 用 `shell: true`
- [x] EADDRINUSE 不 crash（檢測既有 OpenCode 是否健康）
- [x] `.env` 透過 `--env-file` 載入
- [x] `start.ps1` 一鍵啟動腳本
- [x] Docker 設定（Dockerfile + docker-compose.yml）
- [x] 跨瀏覽器同步驗證通過（Playwright 測試 + 使用者確認）

### 待做（未完成）

**1. Caddy reverse proxy on RPi**
- 目標：在 RPi 上的 Caddyfile 加 `opencode.sisihome.org` 的 entry，指到 `kevinhome:9223`
- 位置：RPi 的 Caddyfile（路徑參考 homelab-docs 或 RPi 上 `/etc/caddy/Caddyfile`）
- 需 Tailscale 網路存取 kevinhome
- 之前試過 SSH 到 RPi 但連不上，需要使用者確認 RPi 可達性或提供新的連線方式

**2. 開機自動啟動（Persistent startup on kevinhome）**
- 目標：Windows 開機後自動跑 proxy，不需手動點 `start.ps1`
- 選項：
  - Windows Task Scheduler（啟動觸發器 = 登入時，動作 = 執行 `start.ps1`）
  - PM2 + pm2-windows-service
  - NSSM（Non-Sucking Service Manager）包成 Windows Service
- 推薦 Task Scheduler，因為最簡單且不需額外安裝
- 注意：需要確保 `opencode` CLI 在 Task Scheduler 的 PATH 中可見（可能要用絕對路徑或在 `start.ps1` 裡 `$env:PATH` 加料）

**3. （可選）清理舊 "opencode-remote" 空白 sessions**
- 測試過程中 `createSession()` 創建了一些標題為 "opencode-remote" 的空 session
- 它們會污染 session 列表（出現在左側欄）
- 可透過 `DELETE /session/<id>` 清理，或讓 OpenCode 原生 UI 右鍵刪除
- 非必要，但會讓 UI 更乾淨

### 驗證方式

跨瀏覽器同步測試（Playwright headless）：
```bash
# 假設 proxy 已在 9223 運行
/c/Users/h1114/AppData/Local/Programs/Python/Python312/python.exe -c "
import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True)
        c1 = await b.new_context(); p1 = await c1.new_page()
        await p1.goto('http://localhost:9223/', wait_until='commit')
        await asyncio.sleep(5)
        c2 = await b.new_context(); p2 = await c2.new_page()
        await p2.goto('http://localhost:9223/', wait_until='commit')
        await asyncio.sleep(5)
        print('Same URL?', p1.url == p2.url)
        await b.close()
asyncio.run(main())
"
```

真實瀏覽器驗證：Chrome 和 Edge（或 Chrome 無痕模式）分別打開 `http://localhost:9223/`，兩邊應看到完全相同的 session 畫面（標題、對話歷史都一致）。

## 關鍵提交紀錄（commit history for context）

- `0de4b50` — 重寫為透明 proxy（移除 Job Queue/Runner 舊架構）
- `c0109d5` — Windows `shell: true` spawn 修正
- `5d899f9` — 第一次修正 redirect 格式（`/global/session/<id>`，後證明仍不對）
- `1f23077` — **最終修正**：改用 `/<base64url(dir)>/session/<id>`，這才是正確的 SPA URL 格式
- `6e38e24` — 加 `start.ps1`
- `3f04c62` / `c72806e` — 文件同步
