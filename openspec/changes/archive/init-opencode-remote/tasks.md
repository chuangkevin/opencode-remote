## 1. Monorepo / 專案初始化

- [x] 1.1 建立 root workspace 設定：`package.json`、`tsconfig`、`.gitignore`、共用 scripts
- [x] 1.2 初始化 `packages/web`：React + Vite + TypeScript
- [x] 1.3 初始化 `packages/server`：Fastify + TypeScript API 專案
- [x] 1.4 初始化 `packages/runner`：本機長駐 runner 專案，負責連接 OpenCode server
- [x] 1.5 建立 `.env.example`，涵蓋 SQLite path、OpenCode server URL、VAPID keys、base URL 等設定

## 2. Server / Thread 與狀態儲存

- [x] 2.1 定義 SQLite schema：`projects`、`threads`、`jobs`、`thread_events`、`permission_requests`、`push_subscriptions`
- [ ] 2.2 建立 migration / startup init 流程
- [x] 2.3 實作 thread CRUD API：建立 project、建立 thread、列出 thread、取得 thread 詳情
- [x] 2.4 實作 dispatch API：送出 prompt、列出 jobs、查詢 thread timeline
- [x] 2.5 實作 permission reply API，允許前端批准 / 拒絕 OpenCode permission request
- [x] 2.6 實作前景 SSE API，讓 PWA 可追蹤 thread / job 狀態變化
- [x] 2.7 實作 thread timeline sequence / replay 規則，支援 SSE 重連與 full reload 同步

## 3. Runner / OpenCode 連接層

- [x] 3.1 建立 OpenCode client 封裝，連接既有 `opencode serve`
- [x] 3.2 實作 thread -> OpenCode session 映射策略（首次 dispatch 建 session，後續重用）
- [x] 3.3 實作 async prompt dispatch，改由 runner 持續執行而非綁定前端 request
- [x] 3.4 訂閱 OpenCode SSE event stream，轉譯為 thread events / job status / permission requests
- [x] 3.5 實作 runner claim lease / heartbeat / recovery 邏輯，避免 crash 後 job 永遠卡住
- [ ] 3.6 實作 job abort 與 session unhealthy 標記策略，不做 silent remap
- [ ] 3.7 驗證桌面仍可對映射出的 session 使用 `opencode attach`

## 4. Web / iPhone PWA Shell

- [x] 4.1 建立 app shell、路由與基本 layout（projects、threads、thread detail）
- [x] 4.2 建立 PWA metadata：manifest、icons、theme color、Apple web app meta
- [x] 4.3 建立 service worker 與 app shell cache，確保已安裝 PWA 可快速啟動
- [x] 4.4 實作 iPhone safe-area / Dynamic Island 版面規則
- [x] 4.5 實作 thread detail UI：prompt composer、timeline、job status、permission action buttons
- [x] 4.6 串接 SSE 前景更新與 reload/resume 流程，確保重開 PWA 可回到最新 server state

## 5. Web Push / 背景通知

- [ ] 5.1 建立 VAPID key 管理與 push subscription API
- [ ] 5.2 實作 server 端通知派送：job completed、job failed、permission requested
- [x] 5.3 實作 service worker notification click 行為，導回對應 thread
- [ ] 5.4 驗證 iPhone 已安裝 PWA 上的通知授權與通知送達流程

## 5.5 Internal Security / runner 與 server 邊界

- [x] 5.5.1 決定並實作 v1 的 runner -> server 驗證方式（shared secret 或等價私有驗證）
- [x] 5.5.2 確保 runner 控制面 API 不對一般 web client 暴露

## 6. Verification / 驗證與部署

- [x] 6.1 建立本機開發流程：同時啟動 web、server、runner、opencode serve
- [ ] 6.2 驗證手機送出任務後，切 app / 鎖屏不影響 runner 繼續執行
- [ ] 6.3 驗證 permission request 可從手機批准並繼續同一條 session
- [ ] 6.4 驗證完成通知 / 錯誤通知 / 點擊通知回 thread 的完整流程
- [ ] 6.5 建立部署說明，包含 Tailscale HTTPS / PWA 安裝 / Web Push 前提
