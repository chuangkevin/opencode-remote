# opencode-remote — AI Assistant Context

> **操作手冊：** 服務啟動、重啟、故障排除等操作流程請參考 [`OPERATIONS.md`](./OPERATIONS.md)

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

## 已知限制

### 無法注入自動刷新 Script

**限制：** 無法在 HTML 中注入 JavaScript（如 visibility-based auto-reload）來改善使用體驗。

**根本原因：HTTP 協議違規導致 Caddy 關閉連接**（2026-04-22 確認）

1. **修改 HTML 必須 buffer 整個響應**：
   ```typescript
   // 需要這樣做才能注入 script
   const chunks: Buffer[] = [];
   proxyRes.on("data", chunk => chunks.push(chunk));
   proxyRes.on("end", () => {
     let body = Buffer.concat(chunks).toString("utf8");
     body = body.replace("</body>", `${SCRIPT}</body>`);
     res.end(body);  // ← 問題在這裡
   });
   ```

2. **從 OpenCode 收到的 response 包含 `Transfer-Encoding: chunked` header**

3. **刪除 Content-Length 但保留 Transfer-Encoding 造成協議違規**：
   ```typescript
   delete headers["content-length"];  // 因為內容長度改變
   // 但 Transfer-Encoding: chunked 被保留了
   res.writeHead(proxyRes.statusCode ?? 200, headers);
   res.end(body);  // 發送完整 body string，不是 chunked 格式
   ```

4. **HTTP 協議違規**：
   - `Transfer-Encoding: chunked` 表示數據會以特殊格式分塊傳輸（每塊前有長度標記）
   - 但 `res.end(body)` 直接發送完整內容，**不符合 chunked 編碼格式**
   - Node.js 本地能容忍這個錯誤（localhost:9223 訪問正常）
   - **Caddy 嚴格遵守 HTTP 規範**：
     - 看到 `Transfer-Encoding: chunked` header
     - 期待接收 chunked 格式數據
     - 實際收到的是完整 body（非 chunked 格式）
     - 直接關閉連接 → `curl: (18) transfer closed with outstanding read data remaining`

5. **嘗試修復失敗**：
   - ❌ 設定明確的 `Content-Length`：連接仍被關閉
   - ❌ 在首個 data chunk 立即寫入 headers：連接仍被關閉
   - ❌ 加入 error handling：無法解決根本問題
   - ✅ **唯一解法：完全透明 pipe，不修改內容**

**結論：**

- 必須保持**完全透明的 proxy**（`proxyRes.pipe(res)`，不修改任何內容）
- 代碼已移除所有 HTML 修改邏輯（包括 VISIBILITY_SCRIPT）
- 手機瀏覽器不會自動 reload（可接受的代價）
- 這是架構限制，無法在不破壞核心功能的前提下改善

**症狀對比：**

| 模式 | 本地訪問 (localhost:9223) | HTTPS/Caddy 訪問 |
|------|--------------------------|-----------------|
| 透明 pipe | ✅ 正常 | ✅ 正常 |
| HTML 修改 | ✅ 正常 | ❌ `transfer closed` / `Empty reply` |

**驗證方式：**

```bash
# 測試 HTTPS 訪問
curl -L https://opencode.sisihome.org/
# 應返回完整 HTML（約 2365 bytes）

# Playwright 測試
node test-screenshot2.mjs
# 應成功載入並生成 opencode-screen.png
```

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

**⚠️ 必須使用 opencode-cli.exe（重要！）**

Windows 上 OpenCode 有兩個執行檔：
- `OpenCode.exe` (25MB) - GUI 版本，會立即退出（exit code 0）
- `opencode-cli.exe` (180MB) - CLI 版本，正確的 headless server

**問題症狀：**
```
[opencode-remote] spawning opencode serve in D:\GitClone\_HomeProject
opencode exited with code 0
```

**錯誤做法：**
```typescript
spawn("opencode", ["serve", ...])  // 在 Windows 上會啟動 OpenCode.exe (GUI)
```

**正確做法：**
```typescript
// packages/server/src/index.ts (已修正)
const opencodeCmd = process.platform === "win32"
  ? "C:\\Users\\Kevin\\AppData\\Local\\opencode\\opencode-cli.exe"  // 明確指定 CLI 版本
  : "opencode";

spawn(opencodeCmd, ["serve", ...], {
  shell: process.platform === "win32",  // Windows 需要 shell
  ...
});
```

**驗證方式：**
```powershell
# 確認使用的是 CLI 版本
ls "C:\Users\Kevin\AppData\Local\opencode\opencode-cli.exe"
# 應該是 180MB 左右

# 服務啟動後檢查
netstat -ano | findstr :4096
# 應該看到 LISTENING 狀態持續存在
```

**Directory 亂碼：** 某些舊 session 的 `directory` 欄位含有非 UTF-8 bytes（Windows 路徑編碼問題）。URL 必須用 session 自己的 `directory` 編碼（才能對應 SPA 內部 workspace context），所以亂碼 session 產生的 URL 無法使用。解法是優先挑選 `directory === OPENCODE_DIRECTORY` 的 session，這樣被編碼的就是乾淨的設定路徑。

**EADDRINUSE：** 開發時 OpenCode 可能已在 port 4096 運行。proxy 的 spawn 會失敗，但 `oc.on("exit")` handler 會檢查 OpenCode 是否已經健康，若是則不 crash。

### 認證問題與解決方案

**問題：OpenCode serve 預設要求 HTTP Basic Authentication**

當 OpenCode serve 啟動時，所有 HTTP 端點（包括 `/global/health` 和 `/session`）都會返回 `401 Unauthorized`，並要求 Basic Authentication。這會導致：
- proxy 的 `waitForOpenCode()` 健康檢查無法通過
- proxy 無法啟動
- 瀏覽器存取時會跳出登入提示

**根本原因：**
- OpenCode 檢查環境變數 `OPENCODE_SERVER_PASSWORD`
- 如果該變數存在且非空，OpenCode 會啟用 HTTP Basic Auth
- 如果該變數未設定或為空字串，OpenCode 會以無認證模式運行

**解決方案（已實作）：**

在 `packages/server/src/index.ts` 的 spawn 配置中，明確設定環境變數：

```typescript
const oc = spawn(
  "opencode",
  ["serve", "--hostname", "127.0.0.1", "--port", String(config.opencodePort)],
  {
    cwd: config.opencodeDirectory,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: "" },  // 關鍵：清空密碼
  },
);
```

**為什麼需要明確設定：**
- Node.js spawn 預設會繼承父進程的環境變數
- 如果開發環境或系統環境中設定了 `OPENCODE_SERVER_PASSWORD`，子進程會繼承該值
- 必須明確設為空字串 `""` 來覆蓋任何繼承的值

**參考文件：**
- homelab-docs 的 OpenCode Web 操作手冊記載了相同的解決方式
- 標準啟動命令：`$env:OPENCODE_SERVER_PASSWORD=$null; & 'opencode-cli.exe' web ...`

**驗證方式：**
```bash
# 應返回 {"healthy":true,"version":"1.4.3"}，而非 Unauthorized
curl http://localhost:4096/global/health
```

## 設定（`.env`）

```env
OPENCODE_DIRECTORY=D:\Projects\_HomeProject   # OpenCode 工作目錄
PORT=9223                                       # proxy 對外 port
OPENCODE_PORT=4096                              # OpenCode 內部 port
SESSION_REFRESH_INTERVAL_MS=30000              # session 刷新間隔
```

`.env` 檔案由 `--env-file` 從 root 載入（`npm start` / `npm run dev` 已設定）。

## 啟動方式

**主要啟動（AI agent / 自動化可用）：** `.\start-hidden.ps1`
→ 背景執行，不阻塞，可透過 PowerShell tool 直接執行

**停止：** `.\stop.ps1`（同時停止 proxy 和 OpenCode，AI 可執行）

**開發：** `npm run dev`（tsx watch，自動重載，AI 可執行，但會阻塞）
**Docker：** `docker compose up`（需設 `WORKSPACE_PATH` 環境變數）

> **手動備用（需使用者在終端機操作）：** `npm start`
> 前景模式，日誌直接顯示。AI agent 無法用此方式啟動（阻塞式 + terminal 只有 click 權限）。

**Health check 確認啟動成功（AI 可執行）：**
```powershell
curl http://localhost:4096/global/health   # 應返回 {"healthy":true,...}
curl http://localhost:9223/                # 應返回 302 redirect
```

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
- [x] `start.ps1` / `start-hidden.ps1` 啟動腳本（前景/背景）
- [x] `stop.ps1` / `restart-service.ps1` 停止與重啟腳本
- [x] Docker 設定（Dockerfile + docker-compose.yml）
- [x] 跨瀏覽器同步驗證通過（Playwright 測試 + 使用者確認）

### 待做（未完成）

**1. ~~Caddy reverse proxy on RPi~~** ✅ **已完成 (2026-04-20)**
- ✅ Caddyfile 已包含 `opencode.sisihome.org` 配置，指向 `100.83.112.20:9223`
- ✅ Caddy 已重新載入
- ✅ 驗證通過：`https://opencode.sisihome.org/` 正常運作
- ✅ Session 重導向正常，OpenCode Web UI 可透過域名存取
- ✅ 修正 Caddy gzip 錯誤（添加 `transport http { compression off }` 配置）
- ✅ 頁面內容正常載入（59 行 HTML），visibility script 正常注入

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

## Troubleshooting

### dist/ 目錄包含舊架構代碼

**問題：** 執行 `npm start` 後發現服務運行的是舊的 Fastify + Database 架構，而非透明 proxy。

**原因：** `packages/server/dist/` 目錄包含之前架構編譯的代碼，TypeScript 編譯器不會自動刪除舊檔案。

**解法：**
```bash
npm run build  # 重新編譯，覆蓋舊的 dist/index.js
```

**驗證：**
```bash
head -20 packages/server/dist/index.js
# 應該看到 "import http from "node:http"" 和 proxy 相關代碼
# 而不是 "import Fastify from 'fastify'"
```

### OpenCode 認證問題（詳見上方「認證問題與解決方案」章節）

如果 OpenCode 啟動後所有端點返回 `401 Unauthorized`，檢查：
1. spawn 時是否設定了 `env: { ...process.env, OPENCODE_SERVER_PASSWORD: "" }`
2. 系統環境變數中是否存在 `OPENCODE_SERVER_PASSWORD`

### Port 衝突

如果 `npm start` 失敗並顯示 port 已被占用：
```bash
# Windows
netstat -ano | findstr :9223
netstat -ano | findstr :4096

# 停止占用 port 的進程
Stop-Process -Id <PID> -Force
```

### Caddy Gzip 錯誤導致空白頁面

**問題：** 透過 `https://opencode.sisihome.org` 存取時，頁面返回 200 但內容為空（0 bytes）。Caddy 日誌顯示：
```
"error":"reading: gzip: invalid header"
```

**原因：** Caddy 的 reverse_proxy 預設會在 HTTP transport 層自動處理壓縮，即使 upstream 沒有發送 gzipped 內容，Caddy 也可能嘗試壓縮/解壓縮導致錯誤。我們的 proxy 使用 `Transfer-Encoding: chunked` 發送 HTML（因為注入 visibility script 後長度改變），這與 Caddy 的自動壓縮處理產生衝突。

**解法（Caddyfile 配置）：**
```caddyfile
@opencode host opencode.sisihome.org
handle @opencode {
    reverse_proxy 100.83.112.20:9223 {
        flush_interval -1              # SSE 支援
        header_up -Accept-Encoding     # 移除請求的壓縮要求
        header_down -Content-Encoding  # 確保回應不帶壓縮標頭
        transport http {
            compression off            # 關鍵：禁用 transport 層壓縮
        }
    }
}
```

**關鍵配置：**
- `transport http { compression off }` — 禁用 Caddy 在與 upstream 通訊時的自動壓縮處理
- `flush_interval -1` — 禁用 buffering，支援 SSE streams（`/global/event` keep-alive）
- `header_up -Accept-Encoding` — 不向 upstream 發送 Accept-Encoding header
- `header_down -Content-Encoding` — 移除回應中的 Content-Encoding header（防護措施）

**驗證：**
```bash
# 應返回完整的 HTML（約 59 行）
curl -s https://opencode.sisihome.org/<session-url> | wc -l

# 檢查 Caddy 日誌，不應再有 gzip 錯誤
docker logs caddy 2>&1 | grep 'gzip'
```

**錯誤的嘗試（不要使用）：**
- `encode none` — Caddy 沒有這個語法，會導致啟動失敗
- 單獨使用 `flush_interval -1` 或 `header_up` 無法解決問題，必須同時禁用 transport compression

## 關鍵提交紀錄（commit history for context）

- `0de4b50` — 重寫為透明 proxy（移除 Job Queue/Runner 舊架構）
- `c0109d5` — Windows `shell: true` spawn 修正
- `5d899f9` — 第一次修正 redirect 格式（`/global/session/<id>`，後證明仍不對）
- `1f23077` — **最終修正**：改用 `/<base64url(dir)>/session/<id>`，這才是正確的 SPA URL 格式
- `6e38e24` — 加 `start.ps1`
- `3f04c62` / `c72806e` — 文件同步
- `4eb4a2d` — **認證修正**：設定 `OPENCODE_SERVER_PASSWORD=""` 禁用認證，完成 Caddy 部署

## 重大修復記錄

### 2026-04-22: Caddy HTTPS 連接問題修復

**問題：** 透過 `https://opencode.sisihome.org` 訪問時連接失敗
- 症狀：`curl: (18) transfer closed with outstanding read data remaining` 或 `Empty reply from server`
- 本地訪問正常 (localhost:9223)
- 直接 Tailscale HTTP 訪問正常
- 僅 Caddy HTTPS 訪問失敗

**根本原因：** HTTP 協議違規
- 原代碼嘗試注入 VISIBILITY_SCRIPT 到 HTML 中（用於手機瀏覽器自動 reload）
- 修改 HTML 需要 buffer 整個 response
- 從 OpenCode 收到的 response 包含 `Transfer-Encoding: chunked`
- 代碼刪除 `Content-Length` 但保留 `Transfer-Encoding: chunked`
- 然後用 `res.end(body)` 發送完整 body（不是 chunked 格式）
- Node.js 本地能容忍，但 Caddy 嚴格遵守規範，發現格式不符後關閉連接

**解決方案：** 完全移除 HTML 修改邏輯
- 移除 `VISIBILITY_SCRIPT` 常量
- 改為純透傳代理：`proxyRes.pipe(res)`
- 不再修改任何 HTML 內容
- 所有 response 保持原始 headers 和 body

**代價：** 手機瀏覽器不會在背景超過 10 秒後自動 reload（可接受）

**驗證：**
```bash
curl -L https://opencode.sisihome.org/  # 返回完整 HTML (2365 bytes)
node test-screenshot2.mjs                # Playwright 測試成功
```

**相關文件：**
- `packages/server/src/index.ts` - 移除 HTML 修改邏輯，簡化為純透傳
- `OPERATIONS.md` - 新增操作手冊

### 2026-04-22 之前: Windows OpenCode 啟動失敗

**問題：** OpenCode server 立即退出 (exit code 0)
```
[opencode-remote] spawning opencode serve
opencode exited with code 0
```

**根本原因：** 使用錯誤的執行檔
- Windows 上有兩個執行檔：
  - `OpenCode.exe` (25MB) - GUI 版本
  - `opencode-cli.exe` (180MB) - CLI 版本
- `spawn("opencode")` 在 Windows 上會啟動 GUI 版本
- GUI 版本會立即退出，無法作為 headless server

**解決方案：** 明確指定 opencode-cli.exe
```typescript
const opencodeCmd = process.platform === "win32"
  ? "C:\Users\Kevin\AppData\Local\opencode\opencode-cli.exe"
  : "opencode";
```

**相關 commit：** 參見 `packages/server/src/index.ts` line 144-146
