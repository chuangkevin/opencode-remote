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

**Directory 亂碼：** 某些 session 的 `directory` 欄位含有非 UTF-8 bytes（Windows 路徑編碼問題）。永遠用 `config.opencodeDirectory`（乾淨的設定值）來做 `encodeDirSlug()`，不要用 session 存儲的 directory 直接編碼。

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
