## Why

現在的 OpenCode Web 使用方式仍然依賴「前景中的瀏覽器 tab」。在 iPhone 上切 app 或鎖屏後，前端連線常被系統暫停，導致任務不適合長時間背景執行，也缺少像 Claude Dispatch 一樣的持久 thread、完成通知、與待批准回呼體驗。

`opencode-remote` 要解決的不是單純把 OpenCode UI 搬上手機，而是建立一個真正可長期存在的 remote dispatch 層：手機 PWA 只負責發號施令與看狀態，家裡桌機上的 local runner 持續連接 `opencode serve`，把同一條 thread 對應到可恢復的 OpenCode session。

## What Changes

- 建立全新 monorepo：`packages/web`、`packages/server`、`packages/runner`
- 建立 iPhone 優先的 PWA Web UI，支援安裝到主畫面、safe area、thread/resume、即時狀態與批准互動
- 建立 server API 與 SQLite 儲存層，保存 projects、threads、jobs、permission requests、push subscriptions
- 建立 local runner，持續連接本機 `opencode serve`，將 thread 映射到 OpenCode session 並轉譯 SSE 事件
- 建立 Web Push 通知流程，支援任務完成、錯誤、待批准通知

## Non-Goals

- 不在 v1 內做多使用者帳號、角色、ACL
- 不在 v1 內把服務暴露到公網；預設部署邊界是 Tailscale / 私有 HTTPS
- 不在 v1 內做 MCP bridge 或讓外部 agent 直接控制系統
- 不在 v1 內做多 runner、分散式排程、或雲端工作節點
- 不在 v1 內重建完整 OpenCode 編輯器；桌面進階操作仍以 `opencode attach` / TUI 為主

## Success Criteria

- iPhone 安裝後可作為 PWA 獨立啟動，且 UI 不被 safe area / Dynamic Island 擋住
- 手機送出 prompt 後，即使切 app 或關掉 PWA，家中 runner 仍持續執行同一個 OpenCode session
- 使用者重新打開 PWA 後，可回到同一條 thread 並看到最新 server-side 狀態
- 當 OpenCode 需要 permission approval、任務完成或執行失敗時，iPhone 能收到對應通知
- 使用者可在桌面透過既有 OpenCode session attach 到相同工作上下文，而不是另開一條無關對話

## Capabilities

### New Capabilities

- `dispatch-threads`: 持久化 thread / job / permission 流程，將 thread 映射到 OpenCode session 並支援 async dispatch
- `pwa-shell`: iPhone PWA shell、thread UI、SSE 前景同步、safe-area 版面與安裝能力
- `push-notifications`: Web Push 訂閱、通知派送、點擊通知後回到對應 thread

### Modified Capabilities

- 無，這是全新 repo

## Impact

- **新增 repo**：`opencode-remote`
- **本機依賴**：本機或同機器可用的 `opencode serve`
- **技術棧**：TypeScript、React + Vite、Node.js、SQLite、Web Push
- **部署要求**：PWA 與 Web Push 需要 HTTPS；v1 預設透過 Tailscale HTTPS domain 達成
- **安全模型**：信任邊界放在 Tailnet / 私有網路，server 內部先不實作多帳號驗證
