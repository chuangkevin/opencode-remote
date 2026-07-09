# 在 OpenCode 加入自架 Local LLM Provider

把自架的 OpenAI 相容 LLM（例如 `llama-server` 跑 `qwen2.5-vl-32b`）接進 OpenCode，
當成一個可選的 provider / model。適用於 OpenCode 桌面版與 CLI（兩者共用 `opencode.json` /
`opencode.jsonc` 的 `provider` 區塊）。

## 前提

自架的推論伺服器需提供 **OpenAI 相容 API**，端點在 `/v1`（`/v1/models`、
`/v1/chat/completions`）。以 `llama.cpp` 的 `llama-server` 為例，預設就長這樣：

- 內網位址範例：`http://<host>:18080/v1`
- 家用網域（走 Caddy + 內網 DNS）：`https://llm.example.org/v1`

## 設定（`opencode.json` / `opencode.jsonc`）

在使用者層級設定檔加入一個 `provider` 條目（macOS/Linux：`~/.config/opencode/opencode.jsonc`；
Windows：`%USERPROFILE%\.config\opencode\opencode.jsonc`）：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "private-llm": {
      "name": "Local LLM",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://<tailnet-ip>:18080/v1"
      },
      "models": {
        "qwen2.5-vl-32b": { "name": "qwen2.5-vl-32b" }
      }
    }
  }
}
```

- `npm: "@ai-sdk/openai-compatible"` — 讓 OpenCode 用標準 OpenAI 相容轉接器打這個端點。
- `models` 的 key（`qwen2.5-vl-32b`）必須是伺服器 `/v1/models` 回傳的 model id。
- 存檔後**重啟 OpenCode**（桌面版或 CLI）才會重讀設定；接著在 model 選單就會出現
  `Local LLM / qwen2.5-vl-32b`。

## ⚠️ 最常見的坑：`baseURL` 必須包含 `/v1`

`@ai-sdk/openai-compatible` 會在 `baseURL` **後面接** `/chat/completions`。所以：

| baseURL 設定 | 實際打到的路徑 | 結果 |
|---|---|---|
| `https://llm.example.org`（❌ 少 `/v1`） | `https://llm.example.org/chat/completions` | 路徑不存在 → 請求**永遠卡住 / 逾時**，UI 停在「思考中」 |
| `https://llm.example.org/v1`（✅） | `https://llm.example.org/v1/chat/completions` | 正常回應 |

症狀是「選了 local 模型送出後永遠沒反應」，很容易誤判成網路不通或模型太慢，但根因常常
只是 `baseURL` 少了 `/v1`。

## 建議用 Tailnet IP，不要用網域

自架 LLM 若掛在家用網域（如 `llm.example.org`），該網域通常依賴內網 DNS（Pi-hole）+ Caddy
反向代理。家裡網路一有狀況、或裝置離開家用 LAN，網域就可能解析不到，local provider 跟著失效。

改用 **Tailscale 的機器 IP**（`100.x.y.z`）直連推論伺服器，可繞過內網 DNS / 反向代理，只要
Tailscale 連著、來源與目標機器都在線就能用：

```jsonc
"options": { "baseURL": "http://100.x.y.z:18080/v1" }
```

在推論伺服器那台跑 `tailscale ip -4` 取得它的 tailnet IP。

## 驗證

設定前先確認端點本身是通的（把 `<base>` 換成你的 `baseURL`）：

```bash
# 1. 列出模型（確認端點與 model id）
curl -s <base>/models

# 2. 實際跑一次 completion（確認能回應、量測延遲）
curl -s <base>/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5-vl-32b","messages":[{"role":"user","content":"回一個字：好"}],"max_tokens":10}'
```

兩個都秒回，代表伺服器沒問題；若 OpenCode 仍卡住，回頭檢查 `baseURL` 是否漏了 `/v1`。
