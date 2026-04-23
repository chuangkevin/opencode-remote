# opencode-remote

在 Windows 上將 [OpenCode](https://opencode.ai) headless server 透過透明 HTTP proxy 暴露給所有裝置。任何裝置打開 URL 都會自動進入同一個最近活躍的 session。

## 啟動

```powershell
cd D:\GitClone\_HomeProject\opencode-remote

# 背景啟動（推薦）
.\start-hidden.ps1

# 前景啟動（查看日誌）
npm start
```

## 確認服務正常

```powershell
# OpenCode 健康狀態
curl http://localhost:4096/global/health
# 預期: {"healthy":true,"version":"1.4.3"}

# Proxy 轉導
curl http://localhost:9223/
# 預期: 302 redirect 到 session URL
```

## 停止

```powershell
.\stop.ps1
```

## 設定（`.env`）

```env
OPENCODE_DIRECTORY=D:\GitClone\_HomeProject   # OpenCode 工作目錄
PORT=9223                                       # Proxy 對外 port
OPENCODE_PORT=4096                              # OpenCode 內部 port
SESSION_REFRESH_INTERVAL_MS=30000              # Session 刷新間隔（ms）
```

複製 `.env.example` 建立 `.env`，修改 `OPENCODE_DIRECTORY` 為你的路徑。

## 架構

```
瀏覽器 → proxy (port 9223) → opencode-cli.exe serve (port 4096, localhost only)
```

- `GET /` → 302 redirect 到最近 session 的 SPA URL
- 其他請求 → 透明 pipe（不修改內容）
- 每 30 秒刷新 active session
- Background SSE keep-alive 防止 OpenCode idle

外網存取：`https://opencode.sisihome.org`（透過 RPi Caddy + Tailscale）

## 詳細文件

- [OPERATIONS.md](./OPERATIONS.md) — 完整操作手冊、故障排除
- [CLAUDE.md](./CLAUDE.md) — 技術細節、架構決策（給 AI assistant 看）
