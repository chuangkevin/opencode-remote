## Context

`opencode-remote` 是一個新的 HomeProject 服務，目標不是重做 OpenCode 本身，而是在 iPhone PWA 上提供類似 Claude Dispatch 的 remote control 體驗。核心問題是 iPhone 背景限制：前端 tab / PWA 一旦切到背景，長連線與執行上下文都可能被系統暫停，因此真正的執行者不能放在手機端。

v1 的實際執行模型必須是 server-authoritative：

- `packages/web` 是可安裝的 iPhone PWA，負責送出命令、前景觀察狀態、處理通知 deep-link
- `packages/server` 是系統真實狀態來源，保存 threads、jobs、permission requests、timeline events、push subscriptions
- `packages/runner` 與 `opencode serve` 同機或同桌面環境運行，持續執行工作並把 OpenCode event 轉成 server 可理解的事件

這個 change 是典型跨模組架構設計：新 monorepo、新資料模型、PWA、SSE、Web Push、OpenCode bridge、單機 homelab 部署邊界。若不先把責任分層、queue ownership、session mapping 與通知模型定清楚，實作很容易走回「手機頁面直接控 runner」的脆弱模式。

## Goals / Non-Goals

**Goals:**

- 讓 iPhone PWA 成為真正可用的 remote dispatch 介面，而不是只是前景聊天頁
- 讓 thread / job 狀態在 server 端持久化，避免瀏覽器生命週期決定任務是否存在
- 將一條 remote thread 穩定映射到同一條 OpenCode session，保留上下文與桌面 attach 能力
- 用 SSE 提供前景即時狀態，用 Web Push 處理背景 attention events
- 保持 v1 的 homelab 複雜度低：單使用者、單 runner、SQLite、Tailscale 私有 HTTPS

**Non-Goals:**

- 不做多使用者登入、角色、共享 thread、ACL
- 不做公網暴露或 SaaS 化部署
- 不做 MCP bridge、外部 agent federation、或多 runner clustering
- 不做完整網頁版 IDE / editor；桌面進階互動仍依賴原生 OpenCode 工具
- 不把所有 OpenCode raw event 都先產品化成複雜 UI

## Decisions

### 1. 整體架構採用 server-authoritative + single-runner 模式

系統採用三層結構：

```text
iPhone PWA
  -> HTTPS REST / SSE / Web Push
packages/server
  -> HTTPS control plane
packages/runner
  -> local OpenCode API / event stream
opencode serve
```

server 是唯一真實狀態來源；runner 只負責 claim 工作、操作 OpenCode、回報事件；web 永遠以 server 狀態為準，不直接假設自己握有執行控制權。

**Why this over direct web -> runner:**

- iPhone PWA 斷線後不能保證頁面還活著
- thread / permission / job history 需要可重播、可恢復的持久化來源
- runner crash/restart 後需要有地方恢復狀態，而不是依賴前端記憶體

**Rejected alternatives:**

- 前端直接打 runner：最簡單，但一遇到 iPhone 背景限制就失去可靠性
- server 與 runner 共用記憶體 / 單進程：耦合太高，日後也不利於把 runner 留在桌機

### 2. 前端固定使用 React + Vite + TypeScript PWA

`packages/web` 用 React + Vite + TypeScript，手工控制 manifest / service worker / Apple meta，符合目前 HomeProject 既有前端風格，也足夠應付 PWA shell。

**Why this over Next.js or heavier SSR stacks:**

- 這個產品的主要頁面是已知資料結構的 app shell，不需要 SSR/SEO
- Vite 冷啟動快，PWA 成本低，與現有 HomeProject 專案一致
- iPhone PWA 成敗重點在安裝、safe area、service worker、push，而不是 SSR

**Rejected alternatives:**

- Next.js / Remix：引入額外複雜度，v1 沒有明顯價值
- WebSocket-only UI：增加雙向狀態同步複雜度，對 v1 沒必要

### 3. 前景即時更新採用 SSE，背景通知採用 Web Push

thread detail 在前景時使用 SSE 接收 timeline event；背景時只用 Web Push 處理三類 attention events：

- permission requested
- job completed
- job failed

**Why this over polling or WebSocket:**

- SSE 很適合 server -> client 單向時間線推送，實作與重連都比 WS 簡單
- iPhone PWA 無法可靠依賴背景 socket，因此背景能力必須交給 push
- polling-only 會讓 thread timeline 顯得鈍，且更耗網路/電池

**Rejected alternatives:**

- 全部用 polling：使用感受太差
- 把 push 當成一般 progress stream：太吵，也不是 iPhone 合理用法

### 4. 後端固定使用 Fastify

`packages/server` 採用 Fastify，負責 REST、SSE、push subscription、queue APIs 與 SQLite access。

**Why this over Express:**

- 在 TypeScript 下比較容易維持 schema/typing 一致
- plugin/lifecycle model 對 SSE、驗證、模組化比較乾淨
- v1 仍是小型 API server，Fastify 的複雜度不高但結構更穩

**Rejected alternatives:**

- Express：不是不能做，但 validation / typing 會比較鬆散
- Hono / 其他新框架：沒有足夠理由脫離 HomeProject 目前常用的 Node server 路線

### 5. 資料模型使用 SQLite + 關聯表 + append-only timeline

資料設計採用「current state + event log」混合模式，而不是 full event sourcing：

- `projects`
- `threads`
- `jobs`
- `thread_events`
- `permission_requests`
- `push_subscriptions`

`thread_events` 為 append-only timeline，保存事件序號、型別、payload 與建立時間；`threads/jobs/permission_requests` 提供列表與 UI 所需的當前投影。

**Why this over document-only or pure current-state tables:**

- 單靠 current-state tables 會失去 timeline / replay / debug 能力
- full event sourcing 對 v1 太重，還需要投影重建
- SQLite 對單使用者 homelab 備份與部署最友善

**Rejected alternatives:**

- Postgres：v1 運維成本不值得
- JSON blob-only store：thread list / job queries 會變差

### 6. runner 以 pull/claim queue 模式與 server 協作

runner 不直接碰 SQLite，而是透過 server API 進行：

- claim queued jobs
- heartbeat / renew lease
- post timeline events
- resolve job status
- forward permission answers / abort actions

推薦使用 lease/heartbeat 模式，避免 runner crash 後 job 永遠卡在 running。

**Why this over runner direct-DB access:**

- server 可以保持唯一資料邊界
- runner 可替換、可重啟，server 仍然能做 recovery 判斷
- 比自建雙向控制通道更容易觀察與除錯

**Rejected alternatives:**

- runner 直接寫 DB：耦合高，未來搬機或加 auth 困難
- server 主動推命令給 runner：需要更複雜的控制通道與連線管理

### 7. 一條 remote thread 對映一條可重用的 OpenCode session

OpenCode session mapping 規則固定為：

- thread 首次 dispatch 時 lazy-create session
- 後續同一 thread 一律 reuse 同一 session
- session 壞掉時不 silently remap，必須標成 unhealthy 並要求明確使用者操作

**Why this over per-job session:**

- thread 的存在意義就是延續同一 coding context
- 桌面 `opencode attach` 相容性也建立在穩定 session identity 上
- 若 silently remap，permission / timeline / desktop continuation 都會變得難以信任

**Rejected alternatives:**

- 每次 job 開新 session：破壞 thread 概念
- 偵測失敗就偷偷換 session：對使用者與桌面 attach 來說太危險

### 8. 部署拓樸以 Tailscale 私有 HTTPS 為信任邊界

v1 預設拓樸：

- `packages/server` + `packages/web` + SQLite：部署在一台 always-on homelab service host
- `packages/runner` + `opencode serve`：部署在實際放 repo/workspace 的桌機
- 兩者都透過 Tailnet 互連

PWA 與 Web Push 需要 HTTPS，因此服務入口應是 Tailscale HTTPS domain 或等價的私有 HTTPS，而不是裸 IP + port。

**Why this over forcing everything onto the same machine:**

- 真實使用情境下，OpenCode 需要靠近桌機工作目錄
- 手機只應依賴 always-on API 入口，不應知道本機 repo 細節

**Rejected alternatives:**

- 公網部署：違反 v1 邊界
- runner 與 server 硬綁同機：降低未來實際使用彈性

## Risks / Trade-offs

- **[iPhone push 僅對已安裝 PWA 可靠]** -> UI 必須清楚引導安裝與授權；未授權時仍可用前景 SSE，不把 push 當唯一通知路徑
- **[SSE 在手機網路切換時會斷線]** -> thread timeline 使用 server sequence 作為權威來源；前端重連時從 last seen sequence 或直接 reload thread detail
- **[runner crash 可能讓 job 卡在 running]** -> 使用 claim lease + heartbeat + timeout recovery；超時後改標 `runner_lost` 或回到可恢復狀態，而不是永遠 pending
- **[OpenCode event model 可能比預期更雜]** -> v1 只正規化核心事件型別，但保留 raw payload JSON 以便 debug 與後續擴充
- **[session attach / local user interaction 可能和 remote job 互相干擾]** -> v1 先接受此 trade-off，但 thread 必須標示當前 job / pending permission 狀態，並避免自動改寫 session mapping
- **[單 runner 沒有 HA，也會是瓶頸]** -> 這是刻意接受的 v1 簡化；schema 與 claim 介面保留未來 runner identity 擴充空間
- **[server 與 runner 之間仍需一層內部信任]** -> v1 先用 Tailnet + shared secret 或等價私有驗證機制保護，不延伸成完整多租戶 auth

## Migration Plan

1. 先建立 monorepo 與三個 package 骨架，確保 server/web/runner 邊界在一開始就清楚
2. 先完成 server schema、thread/job/permission API、runner claim 介面，再做 UI
3. 以 mocked runner 或 fake events 驗證 thread timeline 與 SSE UI，不要等到 OpenCode integration 全通才看前端
4. 再接真實 `opencode serve`，完成 session mapping、permission flow、abort、runner recovery
5. 最後加入 service worker、Web Push、iPhone PWA safe-area polishing

**Rollback strategy:**

- 架構上沒有舊系統要相容；若 rollout 失敗，只需停用新服務即可
- schema 使用新增式 migration；資料仍在單一 SQLite，可直接備份 / 回滾檔案
- 若 push 功能不穩，可先退回「前景 SSE only」而不影響核心 dispatch 模式

## Open Questions

- `packages/server` 的資料層要用 Drizzle、Kysely，還是薄 SQL wrapper：這會影響實作體驗，但不影響核心架構
- service worker 要走手工寫法還是 `vite-plugin-pwa`：等到 web package scaffold 後再依實作摩擦決定
- server/runner 內部驗證要用 shared secret、Tailscale identity headers，或更強的 mTLS：實作前要定，但不阻礙目前架構規劃
- raw OpenCode event 是否要在 UI 提供 debug 展開：v1 可先不做，但資料層要保留 payload
- abort 是否能做到真正 hard cancel，還是只能 best-effort cancel：需依 OpenCode upstream 能力驗證
