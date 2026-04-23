# OpenCode Remote - 操作手冊

## 快速啟動

### 啟動服務

**背景啟動（推薦）：**

```powershell
cd D:\GitClone\_HomeProject\opencode-remote
.\start-hidden.ps1
```

服務在背景執行，不佔用終端：
- 本地訪問: http://localhost:9223
- 外網訪問: https://opencode.sisihome.org

**前景啟動（查看即時日誌）：**

```powershell
cd D:\GitClone\_HomeProject\opencode-remote
npm start
```

輸出直接顯示在終端，方便 debug。Ctrl+C 停止。

### 確認服務正常

啟動後約 10 秒，執行以下 health check：

```powershell
# 1. 確認 OpenCode 本身健康
curl http://localhost:4096/global/health
# 預期：{"healthy":true,"version":"1.4.3"}

# 2. 確認 proxy 正常轉導
curl http://localhost:9223/
# 預期：302 redirect 到 session URL
```

兩個都正常就代表服務完全就緒。

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

`stop.ps1` 會同時停止 proxy (port 9223) 和 OpenCode (port 4096) 兩個進程。

如果需要用 PID 手動停止（例如 start-hidden.ps1 輸出的 PID）：

```powershell
taskkill /F /PID <PID>
```

## 檢查服務狀態

### 完整 Health Check

```powershell
# OpenCode health（核心服務）
curl http://localhost:4096/global/health
# 預期: {"healthy":true,"version":"1.4.3"}

# Proxy health（確認轉導正常）
curl http://localhost:9223/
# 預期: 302 redirect 到 /<base64(dir)>/session/<id>

# 外網訪問（需要 Tailscale 和 Caddy 正常）
curl -L https://opencode.sisihome.org/
# 預期: 完整 HTML（約 59 行）
```

### 檢查端口是否在監聽

```powershell
netstat -ano | findstr :9223   # proxy
netstat -ano | findstr :4096   # OpenCode
```

兩個端口都應顯示 LISTENING 狀態。

## 修改代碼後的流程

```powershell
# 1. 修改代碼 (packages/server/src/*.ts)

# 2. 編譯
npm run build

# 3. 重啟服務
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

**原因:** 之前的進程未正確關閉

**解決:**
```powershell
# 找出占用端口的進程
netstat -ano | findstr :9223
netstat -ano | findstr :4096

# 強制終止進程 (替換 <PID> 為實際進程 ID)
taskkill /F /PID <PID>

# 重新啟動
.\start-hidden.ps1
```

### 問題: OpenCode 立即退出 (exit code 0)

**原因:** 錯誤的 OpenCode 執行檔

**檢查:** 確認 `packages/server/src/index.ts` 第 144-146 行：

```typescript
const opencodeCmd = process.platform === "win32"
  ? "C:\\Users\\Kevin\\AppData\\Local\\opencode\\opencode-cli.exe"  // ← 必須是 CLI 版本
  : "opencode";
```

**不能使用:** `OpenCode.exe` (GUI 版本，會立即退出)
**必須使用:** `opencode-cli.exe` (CLI 版本，180MB)

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
# OpenCode 工作目錄 — 決定要顯示哪個目錄的 sessions
OPENCODE_DIRECTORY=D:\GitClone\_HomeProject

# Proxy 對外 port（瀏覽器訪問的 port）
PORT=9223

# OpenCode 內部 port（僅 localhost）
OPENCODE_PORT=4096

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

如果使用 `start-hidden.ps1`，輸出會重定向。要查看日誌：

```powershell
# 停止隱藏模式
.\stop.ps1

# 以前台模式啟動查看日誌
npm start
```

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
Windows opencode-remote (100.83.112.20:9223)
    ↓ HTTP Proxy
OpenCode Server (127.0.0.1:4096)
    ↓ 文件系統
D:\GitClone\_HomeProject
```

## 相關文件

- `CLAUDE.md` - 專案詳細文檔和開發歷史
- `README.md` - 專案基本說明
- `packages/server/src/index.ts` - 主程序源碼
- `.env` - 環境變量配置

## 更新歷史

### 2026-04-22
- 禁用 HTML 修改功能以解決 Caddy HTTPS 兼容性問題
- 移除 VISIBILITY_SCRIPT 注入邏輯
- 改為純透傳代理模式
- 修復：Transfer-Encoding: chunked 導致的連接關閉問題
