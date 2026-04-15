# OpenCode Remote Client — 補完 + 手機遠端體驗

## 背景
opencode-remote 已有 monorepo 架構（web PWA + server + runner），init-opencode-remote change 完成了約 80%。剩餘未完成項目 + 使用者實際使用需求需要收斂。

核心目標：手機只是文字輸入工具，host 在背景做事，手機連上就繼續打字。像 Claude App Dispatch 一樣。

## 現有架構（已完成）
- packages/web: React + Vite PWA, safe-area, SSE 前景同步
- packages/server: Fastify + SQLite, CRUD, SSE, dispatch API
- packages/runner: OpenCode bridge, session mapping

## 未完成項目（從 init tasks.md 繼承）

### P0 — 必須完成才能用
- [ ] 2.2 migration/startup init 流程
- [ ] 3.6 job abort / session unhealthy 標記
- [ ] 6.2-6.5 端到端驗證 + 部署文件

### P1 — 手機體驗核心
- [ ] 斷線自動重連 + 回補未讀訊息（SSE reconnect with last-event-id）
- [ ] 離線 transcript cache（IndexedDB）— 手機無網路時看之前的對話
- [ ] Session 切換 UX — 手機上快速切換不同工作階段
- [ ] Host 狀態面板 — 連線狀態、active sessions 數、CPU/memory

### P2 — 通知
- [ ] 5.1-5.2 Web Push VAPID + server 派送
- [ ] 5.4 iPhone Push 驗證
- [ ] 任務完成通知（host 跑完後推到手機）

### P3 — 整合
- [ ] docker-app-portal 加入 opencode-remote 服務
- [ ] Tailscale 存取（跟其他 HomeProject 服務一樣）
- [ ] 3.7 opencode attach 桌面驗證

## 使用情境
1. 在公司/外面用手機開 PWA → 連到家裡 host
2. 看到所有 session 列表 + host 狀態
3. 選一個 session 繼續打字
4. host 背景執行，手機可以關
5. 回來看結果，切到另一個 session
6. 任務完成收到 push notification

## 部署
- Docker on RPi 或 x86 主機
- Port: 待定
- Tailscale 內部存取

## 非目標
- 替代 OpenCode 本身
- 程式碼編輯器
- 桌面版 client
