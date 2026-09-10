# OpenCode Remote - 操作手冊

## 快速啟動

### 啟動服務

**背景啟動（主要方式）：**

```powershell
cd D:\GitClone\_HomeProject\opencode-remote
.\start-hidden.ps1
```

服務在背景執行，不阻塞終端。**AI agent（Claude Code task）可直接透過 PowerShell tool 執行此指令。**

`start-hidden.ps1` 是一鍵啟動：會準備 `.env`、同步 capability config、build、在 configured ports 啟動服務，並先通過 exact CLI version health 與 workspace probe；之後才安裝 watchdog、Windows Desktop bridge 與 updater。

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
# 預期：302 redirect 到 /remote-sessions
```

兩個都正常就代表目前檢查的 Windows 服務完全就緒。

### Windows Desktop bridge 與 updater

安裝器不清除其他 plugin，也不修改 `opencode.json`。它只複製 wrapper 到 `%USERPROFILE%\.config\opencode\plugins\opencode-remote-desktop-bridge.js`，並把 common library 與 ESM `package.json` 放在 sibling private directory `%USERPROFILE%\.config\opencode\opencode-remote\`。runtime credential 固定為 `%LOCALAPPDATA%\opencode-remote\desktop-connection.json`；runtime/CLI state ACL 限 current user 與 SYSTEM。第一次安裝後要手動重啟 Desktop 一次，installer/updater 永不代為重啟。

```powershell
# 安裝（current Remote 必須先通過 exact health/version/probe）
.\deploy\windows\install-opencode-updater.ps1

# 手動 idle-only run
.\deploy\windows\update-opencode-remote.ps1

# Task 與 logs
Get-ScheduledTask -TaskName opencode-remote-updater | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName opencode-remote-updater
Get-Content "$env:LOCALAPPDATA\opencode-remote\logs\opencode-remote-updater.log" -Tail 100

# Strict status 的成功來源只含非 secret 名稱
$workspace = (Get-Content .env | Where-Object { $_ -match '^OPENCODE_DIRECTORY=' } | Select-Object -First 1) -replace '^OPENCODE_DIRECTORY=', ''
$response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:9223/c/session-status?strict=1&directory=$([Uri]::EscapeDataString($workspace))"
$response.Headers['X-OpenCode-Status-Sources']
```

預期 source 至少有 `remote`；Desktop 正在跑時必須同時有 `desktop`，否則 updater defer。Body 維持原 session status map，不含 credential。strict configured Desktop request 失敗會回 502；一般 UI 仍保留單一成功來源 fallback。

Managed CLI pointer 是 `%LOCALAPPDATA%\opencode-remote\cli\active.json`，解析順序在 explicit `OPENCODE_CLI_PATH` 之後、legacy CLI 與 PATH 之前。Pointer 只接受 schema 1、exact version、absolute regular `.exe`，且 lexical/real path 都必須留在 exact immutable version directory；traversal、symlink/reparse escape 一律忽略。

更新器先持有 `Local\opencode-remote-updater`，再持有 `Local\opencode-remote-service-lifecycle`，並在一般preflight前recover `%LOCALAPPDATA%\opencode-remote\update-transaction.json`。它要求current exact health/version/probe、strict known-idle status、bounded npm latest lookup；SemVer latest必須大於current才更新，絕不downgrade。若latest等於current但尚無有效managed pointer，則安裝該exact version完成初始migration。

Pinned package先進unique stage。npm timeout只用exact PID的`taskkill.exe /T /F`並等待process tree退出；pointer切換前的install/version/ACL failure不寫block、不還原pointer、不重啟service。發布immutable version後，updater先atomically寫journal，再建立含PID/token/timestamp的`update.quiesce`，等待1秒重查status，最後才切pointer。watchdog/manual lifecycle共用lifecycle mutex，不能在這段時間競爭。

失敗 recovery：

```powershell
Test-Path "$env:LOCALAPPDATA\opencode-remote\update.blocked"
Get-Content "$env:LOCALAPPDATA\opencode-remote\logs\opencode-remote-updater.log" -Tail 200
Get-Content "$env:LOCALAPPDATA\opencode-remote\cli\active.json" -ErrorAction SilentlyContinue
Get-Content "$env:LOCALAPPDATA\opencode-remote\update-transaction.json" -ErrorAction SilentlyContinue
Get-Content "$env:LOCALAPPDATA\opencode-remote\update.quiesce" -ErrorAction SilentlyContinue
curl "http://127.0.0.1:9223/remote-health"

# 手動確認 previous/legacy CLI 恢復後，重新安裝；health/probe gate 成功才清 block
.\deploy\windows\install-opencode-updater.ps1
```

不要手動刪`cli\versions`、journal或quiesce。下一次updater會先依journal做deterministic recovery：new pointer/runtime健康則finalize；prior pointer/runtime仍健康則視為pre-switch中斷，只清transaction、不重啟；其餘狀態才還原prior pointer/absence並驗證old runtime，再寫block。損壞journal只在current runtime驗證健康後解除quiesce並block待人工檢查；沒有journal的marker只有在已取得exclusive updater mutex、owner正確且超過25分鐘bound後才會回收。Logging與Skynet都是best effort，不得阻止rollback；rollback failure時maintenance留給TTL到期。

`stop.ps1`、`restart-service.ps1`、watchdog與updater不再sweep `OpenCode*`/`opencode*`。Proxy必須同時吻合current `node.exe`的exact `ExecutablePath`與parsed env-file/server-entry argv；child必須吻合`Resolve-OpenCodeCli`的exact executable、parent PID、configured loopback port與完整serve argv。任一configured port被其他process佔用就fail closed，不另找fallback port，也不會碰Desktop。

目前證據範圍：repository tests/typecheck/build、Node static/contract checks 在 macOS 執行；Windows host 先前 offline/version-blocked，所以 live ACL inheritance、Task trigger、Desktop bridge heartbeat、update/restart/rollback 尚待 Windows host runtime validation，不能視為已部署。

> **Port 提醒**：本機 OpenCode CLI 預設用 **4196**（不是 4096），因為 4096 已被
> 本 repo 的 `docker-compose.yml` 容器占用。`.env` 的 `OPENCODE_PORT` 控制；
> 直接打 `http://localhost:4196/global/health` 可以驗證 upstream。詳見「故障排除 / Docker 容器跟 OpenCode 搶 port」。

### 手機工作階段列表

OpenCode 原生 mobile layout 可能只顯示目前 session，不顯示完整工作階段列表。手機可直接開：

```text
https://opencode.sisihome.org/remote-sessions
```

這是 `opencode-remote` 提供的輕量 session picker，點選任一項會進入對應 OpenCode session。
所有 User-Agent 打開 `/` 時，`opencode-remote` 都會導到 `/remote-sessions`，避免 OpenCode 原生 mobile layout 看不到工作階段列表。`/latest` 才會導到最近 active session。

## macOS LaunchAgent（MBA-Kevin.local）

### 固定部署拓樸

```text
Tailnet client
  -> http://100.113.121.103:9223
  -> LaunchAgent io.interagent.opencode-sara
  -> run-opencode-sara.sh (clean environment)
  -> Node proxy (BIND_ADDRESS=100.113.121.103)
  -> OpenCode child (127.0.0.1:4196)
  -> /Users/kevin/Documents/Projects
```

`/remote-sessions` 的執行中狀態另走 same-origin bridge：browser 呼叫
`GET /c/session-status?directory=<absolute-path>`，Node proxy 平行查詢自己啟動的
`127.0.0.1:4196` 與 OpenCode Desktop 的 authenticated dynamic-port loopback
sidecar，再合併成功來源。Remote-owned source timeout 是 1500ms，Desktop source 最多等待
750ms；browser 維持整批 3 秒 timeout、最多 4 個 directory request 並行。這個 endpoint
先做 lexical validation，再以 `realpath` 驗證 requested directory 確實存在於 real root 內；
不存在或透過 symlink 逃出 root 會回 `400`，不會發出 status request。
root 外的復原 pinned session 不會發出 status request，也不顯示執行中 indicator。
一般 UI 呼叫維持 fallback：任一來源失敗不會遮蔽另一來源；兩邊都失敗才回 `502`。updater 使用
`strict=1`：Remote 必須成功；若存在有效的 live Desktop runtime credential，Desktop request 也必須成功。
關閉的 Desktop 沒有工作需要保護，不會阻擋更新；已連線來源任一失敗即回 `502`。重複 session ID 的
`busy` 優先於 `idle`、`retry` 或未知狀態，不受來源順序影響。

- Runtime: `/Users/kevin/.local/share/opencode-remote`
- Plist: `/Users/kevin/Library/LaunchAgents/io.interagent.opencode-sara.plist`
- Logs: `/Users/kevin/Library/Logs/opencode-remote/opencode-sara.log` and `opencode-sara.error.log`
- Node: `/opt/homebrew/bin/node`
- OpenCode: `/opt/homebrew/bin/opencode`
- Tailscale CLI: `/Applications/Tailscale.app/Contents/MacOS/Tailscale`
- Runtime wrapper: `/Users/kevin/.local/share/opencode-remote/run-opencode-sara.sh`
- Updater: `/Users/kevin/.local/share/opencode-remote/update-opencode-sara.sh`
- Updater plist: `/Users/kevin/Library/LaunchAgents/io.interagent.opencode-sara-updater.plist`
- Updater logs: `/Users/kevin/Library/Logs/opencode-remote/opencode-sara-updater.log` and `opencode-sara-updater.error.log`
- Desktop bridge plugin: `/Users/kevin/.config/opencode/plugins/opencode-remote-desktop-bridge.js`
- Desktop bridge library: `/Users/kevin/.config/opencode/opencode-remote/opencode-remote-desktop-bridge-lib.js`
- Desktop connection runtime state: `/Users/kevin/.local/share/opencode-remote/desktop-connection.json`

LaunchAgent 直接執行 installed runtime wrapper。wrapper 先確認 exact Tailscale IPv4，再以 `/usr/bin/env -i` 建立固定 application environment 並 `exec /opt/homebrew/bin/node`；Node 直接啟動 `/opt/homebrew/bin/opencode serve` child。plist 不包含環境變數或 application credentials。

這個 direct-FDA design 已部署。production installer 已連續驗證 clean restart、direct Node ownership，以及移除舊 self-SSH runtime launcher。

這個 macOS 服務沒有 Basic auth，只能綁定核准的 Tailscale IP。不要改成 `0.0.0.0`、不要加 Funnel/Cloudflare Tunnel/public reverse proxy，也不要把 `4196` 對外開放。私有網域是 `https://opencode-sara.sisihome.org`，使用既有 DNS-only wildcard 經 GN100 Caddy；`https://opencode.sisihome.org` 仍是 Windows `kevinhome` 的既有私有路由。

Desktop connection file 是本機 `0600` runtime state，不是設定或部署 secret source。
它只包含 Desktop loopback origin 與 sidecar Basic Auth connection data，由全域 plugin
在 Desktop startup 產生，並在 Desktop process 存活期間每 5 分鐘 heartbeat 更新
`updatedAt`；server 讀取後只回 session status map，credential 永不送到 browser、永不寫入
log、永不 commit。父目錄固定為 `0700`。server 以 `O_NOFOLLOW` 開啟一次後從同一 descriptor
驗證及讀取；檔案格式或權限不符、超過 15 分鐘未更新、時間超前 60 秒以上、PID 已結束，
或 origin 不是 loopback，都會忽略它並回退到 `:4196`。

### Full Disk Access 前置條件

1. 以 `node -p 'fs.realpathSync("/opt/homebrew/bin/node")'` 找出目前 actual Node binary，並在 System Settings > Privacy & Security > Full Disk Access 確認已允許。
2. 以 `node -p 'fs.realpathSync("/opt/homebrew/bin/opencode")'` 找出目前 actual OpenCode binary，並在同頁確認已允許；不要依賴 Homebrew versioned internal layout。
3. 確認 stable launcher paths `/opt/homebrew/bin/node` 與 `/opt/homebrew/bin/opencode` 仍 resolve 到上述 actual binaries。
4. Homebrew upgrade 可能建立新的 Cellar binary。若 resolved path 改變，先對新 binary 重新授權 FDA，並用 disposable direct LaunchAgent 重驗 workspace access，再進行 service deployment。

部署會建立固定、非 secret、`0644` 的 `/Users/kevin/Documents/Projects/.opencode-remote/remote-fda-probe.txt`，且不會替換或刪除共用 `.opencode-remote` 目錄。每次部署與自動更新都必須透過 Remote proxy 呼叫 OpenCode 的 `GET /file/content?path=<absolute>&directory=<workspace>`，驗證回應是 exact text probe；health 成功本身不算 FDA runtime proof。

### 安裝或更新

只在另外取得部署授權後執行：

```bash
cd /Users/kevin/Documents/Projects/private-codebase/opencode-remote
./deploy/macos/deploy-local.sh
```

腳本會先驗證固定 dependencies，再執行 `npm ci` / typecheck / build、用明確 allowlist 複製 runtime、保留 `packages/server/package.json` ESM metadata、安裝 direct runtime wrapper/plist，並以 `0600` 安裝只有一個 function export 的 Desktop bridge wrapper 到既有 `~/.config/opencode/plugins/`，另以 `0600` 安裝 implementation library 與其 ESM package metadata 到 auto-discovery 外的 `~/.config/opencode/opencode-remote/`；兩個目錄皆為 `0700`，installed wrapper 的 `../opencode-remote/` relative import 會指向該 library（不清除其他 plugin、不修改 `opencode.json`）。接著以目前 GUI UID 執行 exact `launchctl bootout/bootstrap/kickstart`。bootout 後會 bounded-wait，直到 exact `9223` 與 `4196` listeners 都不存在；若殘留就 fail closed，不會依 port 或 PID kill process。

Config-time plugin 安裝後必須重啟 OpenCode Desktop，未重啟前不會產生新的 Desktop
connection runtime state。部署腳本本身不會重啟 Desktop。

最後的 bounded success gate 會用固定 JSON helper 解析 `http://100.113.121.103:9223/remote-health` 與 FDA probe response，要求精確的 proxy/port/upstream/healthy/probe 值；確認 LaunchAgent state 是 running、launchctl PID 等於 exact `100.113.121.103:9223` Node listener PID、command 精確為 fixed Node + runtime entry；並確認 exact `127.0.0.1:4196` owner command 是 fixed OpenCode command且為 Node 的 direct child。它不讀 `.env`、不複製 `.env`/secret/node_modules/source，也不遞迴刪除 runtime 或服務資料。通過 main health 與 FDA probe 後才移除 `/Users/kevin/.local/share/opencode-remote/update-opencode-sara.blocked`。

部署主服務通過上述 health gate 後，installer 才會安裝並 bootstrap exact updater LaunchAgent `io.interagent.opencode-sara-updater`，避免其 `RunAtLoad` 與主部署競爭。updater 每 3600 秒檢查一次，也會在載入時檢查一次；plist 不含 secret 或 application environment。

### macOS OpenCode CLI 自動更新

更新政策是 hourly idle-only：每輪先要求目前 CLI version、`/remote-health` 與 FDA probe 都吻合，再查 same-origin `/c/session-status?strict=1&directory=/Users/kevin/Documents/Projects`。strict mode 要求 Remote 成功，且有效 live Desktop credential 存在時 Desktop source 也必須成功；request 失敗、payload 格式未知、status type 未知或任一 session 為 `busy` 時，記錄 `DEFERRED` 並以 exit 0 結束。Desktop 已關閉、沒有有效 credential 時不阻擋；`idle` 與 `retry` 也不阻擋。`brew outdated --quiet opencode` 只接受 exit `0` 且 stdout empty 代表 current，或 exit `1` 且 stdout exact `opencode` 代表有更新；其他組合都在 `DETECT` fail。升級只執行 `HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 brew upgrade opencode`，不升級其他 formula。

只有確認有更新後，updater 才 atomically 建立並擁有 `update-opencode-sara.quiesce`，等待一秒，再重查 strict merged status。marker 存在時，Remote proxy 只拒絕 `/session/<ses id>/message` 與 `/session/<ses id>/prompt_async` 兩種 prompt-creating POST，回 `503` JSON、`Retry-After: 1` 與 `Cache-Control: no-store`；abort、session creation、pins、health 與 status 不受影響。busy 或 status failure 會 defer 並只清掉 updater 自己擁有的 marker。

更新前會記錄 old CLI version 與 `/opt/homebrew/bin/opencode` 的 exact symlink target，且要求 target resolve 到現存 Homebrew executable；再 best-effort 開 Skynet maintenance，只保存該次 POST 回傳的 numeric maintenance ID。更新後只以 `launchctl kickstart -k gui/$UID/io.interagent.opencode-sara` 重啟 Remote service，不重啟 OpenCode Desktop。成功要求 `upstreamHealth.version` 精確等於 new version，且 FDA probe exact match。brew、new-version、restart、health 或 FDA recovery 任一失敗都會先寫 `update-opencode-sara.blocked`，再以 `/bin/ln -sfn` 只還原原本的 OpenCode symlink、重啟 Remote，並要求 old health version 與 FDA probe 都恢復；成功記 `ROLLBACK restored=...` 並關閉自己的 maintenance，否則記 `ROLLBACK_FAILED` 並讓自己的 maintenance 依 10 分鐘 TTL 到期，最後皆 nonzero。block marker 存在時 hourly runs 只 defer，直到 successful manual `deploy-local.sh` 通過 main health + FDA probe 後移除。quiesce marker 會留到 new health 或 rollback 決定完成，再由 owner cleanup。

手動執行已安裝的同一支 updater：

```bash
/Users/kevin/.local/share/opencode-remote/update-opencode-sara.sh
```

檢查 updater 狀態與 log：

```bash
launchctl print "gui/$(id -u)/io.interagent.opencode-sara-updater" | /usr/bin/awk '/^[[:space:]]*(state|runs|last exit code) = /'
tail -n 100 /Users/kevin/Library/Logs/opencode-remote/opencode-sara-updater.log
tail -n 100 /Users/kevin/Library/Logs/opencode-remote/opencode-sara-updater.error.log
```

### 狀態

```bash
uid="$(id -u)"
launchctl print "gui/$uid/io.interagent.opencode-sara" | /usr/bin/awk '/^[[:space:]]*(state|pid|runs|last exit code) = /'
```

不要直接貼出未過濾的 `launchctl print`；GUI launchd domain 可能列出與本服務無關的 inherited environment。

### 重啟、停止

停止：

```bash
uid="$(id -u)"
launchctl bootout "gui/$uid/io.interagent.opencode-sara"
```

重新載入 plist 時，先 `bootout`，再執行：

```bash
uid="$(id -u)"
launchctl bootstrap "gui/$uid" "/Users/kevin/Library/LaunchAgents/io.interagent.opencode-sara.plist"
launchctl kickstart "gui/$uid/io.interagent.opencode-sara"
```

### macOS 驗證

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
/usr/bin/readlink /opt/homebrew/bin/node
/usr/bin/readlink /opt/homebrew/bin/opencode
curl --noproxy '*' http://100.113.121.103:9223/remote-health
launchctl print "gui/$(id -u)/io.interagent.opencode-sara" | /usr/bin/awk '/^[[:space:]]*(state|pid|runs|last exit code) = /'
/usr/sbin/lsof -nP -iTCP@100.113.121.103:9223 -sTCP:LISTEN
/usr/sbin/lsof -nP -iTCP@127.0.0.1:4196 -sTCP:LISTEN
tail -n 100 /Users/kevin/Library/Logs/opencode-remote/opencode-sara.log
tail -n 100 /Users/kevin/Library/Logs/opencode-remote/opencode-sara.error.log
```

驗收時 `/remote-health` 必須精確回報 `proxy="opencode-remote"`、`remotePort=9223`、`upstream="http://127.0.0.1:4196"`、`upstreamHealth.healthy=true`。`launchctl print` 必須為 running，且其 PID 必須等於 `9223` 的 exact Node listener PID；Node command 必須是 `/opt/homebrew/bin/node /Users/kevin/.local/share/opencode-remote/packages/server/dist/index.js`。`4196` 必須只綁 `127.0.0.1`，owner command 必須是 `/opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 4196`，且 PID 是 Node 的 direct child。還要從另一台已授權 Tailnet 裝置開啟 root/native/compact UI，並用兩個瀏覽器確認同一 session。本次 direct-FDA deployment 已完成這些檢查；後續更新仍須重新驗證。

### macOS 故障排除

- Node/OpenCode 出現 `Operation not permitted` 或卡在 `getcwd()`：確認 stable Homebrew path 目前指向哪個 Cellar binary，並在 Full Disk Access 對 actual Node 與 OpenCode binaries 重新授權；用 disposable direct LaunchAgent 重驗後才 redeploy。
- `Expected Tailscale IPv4 ... was unavailable`：確認 Tailscale 已登入，而且 `Tailscale ip -4` 的輸出精確包含 `100.113.121.103`。runtime wrapper 最多等待 60 秒後失敗，launchd 會依 KeepAlive policy 重試，不會退回其他介面。
- launchctl 顯示很快退出：確認 plist 指向 `run-opencode-sara.sh`、wrapper 有 executable permission，並檢查 service error log。
- `bootstrap failed: 5` 或 plist 載入失敗：先跑 `plutil -lint`，再用上方過濾後的狀態指令；若已載入，先精確 `bootout` 該 service target。不要分享未過濾的 `launchctl print` 輸出。
- `/remote-health` 失敗：先看兩個 log，確認 `/opt/homebrew/bin/opencode` 可執行、workspace 存在，且 `4196` 沒有舊程序占用。
- 重啟後 port 仍被占用：installer 會拒絕 bootstrap。記錄 `lsof` 的 PID/command，不要 broad kill 或依 port kill；只用 exact label 的 `launchctl bootout` 管理此服務，再調查 process ownership。

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

`stop.ps1` 會從 `.env` 讀 `PORT` 與 `OPENCODE_PORT`。只有 exact repo server-entry listener 與其 direct loopback child 會被停止；其他 Node/OpenCode/Desktop 或 port owner 會使 lifecycle fail closed，不會被殺。
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

任一檢查失敗時，watchdog 會持有 shared lifecycle mutex，使用 configured ports 做 bounded restart 並等到 health/probe 結果。紀錄寫入 `%LOCALAPPDATA%\opencode-remote\logs\opencode-remote-watchdog.log`。
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
# 預期: 302 redirect 到 /remote-sessions；/latest 才會到 /<base64(dir)>/session/<id>

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

# Proxy bind address（未設定時維持 Windows 既有 default 0.0.0.0）
BIND_ADDRESS=0.0.0.0

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
