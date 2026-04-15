# OpenCode Remote — 遠端行動指令界面

## 背景
OpenCode 是 AI coding agent（類似 Claude Code），目前有 terminal + web UI。問題：web UI 在手機瀏覽器關掉/切背景後 session 斷掉，無法在背景持續工作。

使用者需要像 Claude App Dispatch 一樣的體驗：手機只是文字輸入工具，host 在背景做事，手機連上就繼續打字。

## 核心概念
```
Host（家裡/店內背景跑）
  ├── 持續執行 OpenCode agent，不依賴前端連線
  ├── 管理多個工作階段 (sessions)
  ├── 記住所有設定（CLAUDE.md, memory, .env）
  └── 任務完成後可通知 client

Client（手機 PWA）
  ├── 純文字 input/output（像 Claude Dispatch）
  ├── WebSocket 連到 host
  ├── 連上顯示 host 狀態 + active session
  ├── 切換不同 session
  ├── 斷線重連不影響 host 工作
  └── 離線顯示上次 transcript
```

## 使用情境
1. 在公司用手機開 PWA → 連到家裡 host
2. 選一個 session（例如 sheet-to-car 開發）
3. 打字送指令 → host 執行 → 結果串流回手機
4. 手機鎖屏/切 app → host 繼續跑
5. 回來手機 → 看到 host 執行完的結果
6. 切到另一個 session（例如 home-media debug）
7. host 上所有 session 的 context 都保留

## 架構

### Server（Host 端）
- Node.js process manager
- 包裝 OpenCode CLI/SDK 為 child process
- 每個 session = 一個 OpenCode instance + working directory
- WebSocket server 接收 client 指令
- Session state 持久化到 SQLite（transcript, status, cwd）
- 認證：JWT（簡單帳密）

### Client（手機 PWA）
- React + Tailwind PWA
- WebSocket 連線管理（自動重連）
- Session 列表 + 切換
- 文字聊天界面（markdown render）
- 離線 transcript cache（IndexedDB）
- Service Worker 背景 push notification（Phase 2）

### 通訊協議
```
Client → Server:
  { type: "send", sessionId: "xxx", message: "修好那個 bug" }
  { type: "list-sessions" }
  { type: "create-session", name: "sheet-to-car", cwd: "/path" }
  { type: "switch-session", sessionId: "xxx" }

Server → Client:
  { type: "output", sessionId: "xxx", text: "正在分析...", streaming: true }
  { type: "session-list", sessions: [...] }
  { type: "session-status", sessionId: "xxx", status: "idle"|"running" }
  { type: "notification", title: "任務完成", body: "sheet-to-car build 通過" }
```

## 技術選型
- Host: Node.js + ws (WebSocket) + better-sqlite3 + child_process
- Client: React + Tailwind + PWA (service worker)
- 通訊: WebSocket（即時）+ REST fallback
- 認證: JWT + bcrypt
- 部署: Docker on RPi 或 x86 主機
- Port: 待定（建議 9527 或其他未用的）

## 與現有系統的關係
- docker-app-portal 可以加入 opencode-remote 作為新服務
- 遵循 HomeProject Harness Engineering 標準（CLAUDE.md + ESLint + Prettier + .claude-memory）
- 可以用 Tailscale 從外部存取（跟其他服務一樣）

## 分階段
Phase 1：基礎通訊
- WebSocket server + 簡易 PWA client
- 單 session：建立、發送指令、接收輸出
- JWT 認證
- OpenCode CLI wrapper

Phase 2：多 session + 斷線恢復
- Session 列表切換
- Transcript 持久化 + 離線 cache
- 斷線自動重連 + 回補未讀訊息
- Host 狀態面板（CPU/memory/active sessions）

Phase 3：通知 + 整合
- Push notification（Service Worker）
- Portal 整合
- 多 host 支援（可選）

## 非目標
- 替代 OpenCode 本身（只是遠端界面）
- 自己實作 AI agent
- 桌面版 client（手機優先）
- 程式碼編輯器（不是 VS Code，是指令發送器）
