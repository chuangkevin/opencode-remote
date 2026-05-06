# opencode-remote Capability Alignment Plan

> **Authoritative follow-up:** This file is the original exploratory draft from
> commit `58b857a`. The approved requirement source is
> `openspec/changes/capability-alignment/`, and the approved design is
> `docs/superpowers/specs/2026-05-06-capability-alignment-design.md`.
> Implementation should follow
> `docs/superpowers/plans/2026-05-06-capability-alignment.md`.

> **Path notation:** References to `D:\GitClone\_HomeProject` in this draft are
> historical examples. New work must use `<HOMEPROJECT_ROOT>` and the runtime
> `OPENCODE_DIRECTORY` value so both `D:\Projects\_HomeProject` and
> `D:\GitClone\_HomeProject` are supported.

> **狀態:** 參考草稿（2026-05-06）；正式需求見 `openspec/changes/capability-alignment/`
> **作者:** Claude (claude-opus-4-7)
> **目的:** 讓 opencode-remote（GPT-5.5 後端）的工作能力盡量靠近 Claude Code 的 Cowork / Dispatch 模式
> **超粉規範:** 此文件結合 superpowers `brainstorming` + `writing-plans` 的產出，先有設計決策＋未定問題，再有可逐步執行的任務清單

---

## 0. 背景與目標

### 0.1 現況快照

從 `D:\GitClone\_HomeProject\opencode-remote\` 掃描得到的事實：

| 項目 | 現況 |
|------|------|
| Server 程式 | Node 22 + TypeScript 5.8，純 `node:http` proxy，零 runtime npm deps |
| 對外 endpoint | `https://opencode.sisihome.org` → Tailscale `100.83.112.20:9223` → proxy → `localhost:4096` (opencode-cli.exe) |
| `.env` | `OPENCODE_DIRECTORY=D:\GitClone\_HomeProject` |
| `opencode.json` | **不存在**（global、project 都沒有） |
| `AGENTS.md` | **不存在** |
| `.opencode/` | **不存在** |
| `~/.config/opencode/AGENTS.md` (global) | **未設定**（Windows 路徑為 `%USERPROFILE%\.config\opencode\` 或 `%APPDATA%\opencode\`，待確認） |
| 規則來源 | 只有 root `CLAUDE.md`（opencode 把它當 fallback 載入） |
| 記憶系統 | 無（Claude Code 端有 `homelab-docs/.claude-memory/`） |
| Subagents | 無 |
| MCP servers | 無 |

### 0.2 對齊目標

「Claude Cowork / Dispatch」拆成可量化的能力，逐項對應到 opencode：

| Claude Code 能力 | opencode 對應機制 | 本計畫要做的事 |
|------------------|-------------------|----------------|
| Workspace `CLAUDE.md` + per-repo `CLAUDE.md` | `AGENTS.md` 鏈式載入（`opencode` 沿路徑向上爬） | 加 workspace `AGENTS.md` + 每個 repo 的 `AGENTS.md`（B 節） |
| Skills（`Skill.md` 註冊） | opencode 內建 `skill` 工具讀取 `SKILL.md` | 把 `homelab-docs/skills/` 透過 `instructions` glob 拉進 opencode（B 節） |
| Subagent (`Explore`, `Plan`, `Implement`, `Verify`) | `.opencode/agents/<id>.md`（YAML frontmatter + system prompt） | 建 subagent 目錄並寫 4–5 個基本 agent（D 節） |
| `Cowork` 平行 worktree | opencode `subagent` mode + `git worktree` + 自家 superpowers `using-git-worktrees` | 把 worktree workflow 寫成 `AGENTS.md` 規則 + skill（D 節） |
| Auto-memory（`MEMORY.md` index + 個別 memory files） | 兩種選擇：純檔案模擬 / `@modelcontextprotocol/server-memory` MCP | 走純檔案模擬（C 節，理由見 §C.1） |
| Built-in tools（Read/Edit/Write/Grep/Glob/Bash/WebFetch/WebSearch） | opencode 內建（`bash`, `edit`, `write`, `read`, `grep`, `glob`, `webfetch`, `websearch`, `apply_patch`, `skill`, `todowrite`, `question`） | 不需新增；只需確認 permission 設定（A 節 §A.4） |
| MCP 連接器（GitHub, Filesystem, Browser 等） | `mcp.<name>` JSON 設定 | 設 5 個 MCP（A 節） |
| Completion checklist（commit + push + memory + spec） | `AGENTS.md` 規則 + 直接引用 `homelab-docs/skills/completion-checklist/SKILL.md` | B + D 節 |

### 0.3 驗證標準（done 的定義）

完成後使用者打開 `https://opencode.sisihome.org/`，新建 session 並下達三個任務，分別應該成立：

1. **「列出 `media-processor` 最近 10 個 commit」** — 不需打開檔案，opencode 應透過 `bash` 工具直接 `cd` 到該專案執行 `git log`，並回應在 1 訊息內。
2. **「在 `mind-diary` 加一個 dark-mode toggle，先寫測試再實作」** — opencode 應主動呼叫 `Plan` subagent（或載入對應 skill），產生 task list，且結尾提示 commit + push + memory 更新。
3. **「我之前說過喜歡用 `chuangkevin` 推到 `kevinsisi` 對嗎？」** — opencode 應從 memory 檔案中找到並引用這條偏好，而非說「我不記得」。

---

## 1. 設計決策與未定問題

> **使用者請先確認/修正下列假設後，再進入第 §A 開始的實作計畫。**

| # | 議題 | 我的預設選擇 | 理由 | 替代方案 |
|---|------|-------------|------|---------|
| Q1 | **MCP / AGENTS / 記憶檔放在哪個 repo？** | 全部 commit 進 `opencode-remote` 自己的 repo。`opencode.json` 放 root，`AGENTS.md` 放 root + 各子專案，記憶檔放 `homelab-docs/.opencode-memory/` 與 Claude 的 `.claude-memory/` 並列 | `opencode-remote` 是 server 入口，配置變更要跟程式碼一起做版控。記憶檔放 `homelab-docs` 是因為它已是現有事實儲存的中心點 | (A) 全部放 `homelab-docs`、(B) 走全域 `~/.config/opencode/` |
| Q2 | **`OPENCODE_DIRECTORY` 範圍** | 維持現狀 `D:\GitClone\_HomeProject`（多 repo 共用一個 server） | 使用者已習慣這個入口；opencode 的 instruction layering 會在 `prompt.ts` 沿路徑向上累積，所以開在 parent 也能讀到 per-repo 規則 | 每個 repo 一個 server（運維變重，session 不互通） |
| Q3 | **記憶系統採 MCP 還是純檔案？** | 純檔案 + opencode 內建 `read/write/edit` + `AGENTS.md` 規則明文要求 | `@modelcontextprotocol/server-memory` 用知識圖譜（entities/relations）模型，與 Claude Code 的 markdown 檔案格式不相容；想兩邊互通要再寫橋接。純檔案最直接 | 同時掛 memory MCP，把「結構化關係」交給 MCP，「敘事 memory」走檔案 |
| Q4 | **GPT-5.5 vs Claude 的差異點** | 在 `AGENTS.md` 開頭明確標註「This file is loaded by opencode (GPT-5.5 backend). When committing, use `Co-Authored-By: opencode (gpt-5.5) <noreply@...>`，不要冒用 Claude 署名」 | 避免 commit author 互相污染、避免 GPT 直接複製 Claude 的工具 reference | 不區分（commit author 會混亂） |
| Q5 | **Subagent 採用哪幾隻？** | `explore`（read-only research）、`plan`（spec/plan output）、`implement`（has edit/bash）、`verify`（runs tests/builds，no edit）、`reviewer`（code review only） | 對應 Claude Code 的 4 個內建 + 1 個 review。每隻 permission 不同，避免無界限授權 | 只做 1–2 個 |
| Q6 | **完成檢核（completion checklist）用哪個版本？** | 直接 reuse `homelab-docs/skills/completion-checklist/SKILL.md`（透過 `instructions: ["../homelab-docs/skills/**/SKILL.md"]` glob 拉進來） | 規則就一份，避免雙寫 drift | 在 opencode-remote 內 fork 一份精簡版 |
| Q7 | **Worktree workflow 強制度** | 「鼓勵但不強制」— `AGENTS.md` 寫明大型／互不相依工作要拆 worktree，但不在 hook 層攔下未拆的 commit | 強制會讓單一改檔變麻煩，與 Claude 端目前的彈性一致 | 強制（要在 git hook 加檢查） |
| Q8 | **`websearch` 後端用 Exa 還是別的？** | 暫不啟用。opencode 內建 `websearch` 預設要 Exa API key，沒設定就 noop。改建議掛 `mcp-server-fetch` 做 URL 抓取，搜尋走 GPT-5.5 自帶能力 | 省 API key 預算 | 申請 Exa key |

---

## 2. 文件結構（其餘章節）

A. **MCP 配置計畫**（§A）— `opencode.json` 內容、5 個 MCP server、放置位置、permission
B. **專案指引同步**（§B）— `AGENTS.md` 階層、`instructions` glob、與 Claude `CLAUDE.md` 的關係
C. **記憶系統設計**（§C）— `MEMORY.md` index + 個別 memory files、讀寫時機、與 Claude 端的同步策略
D. **工作流程對齊**（§D）— Subagent 設計、completion checklist、worktree、parallel 任務
E. **實作任務（writing-plans 格式）**（§E）— 12 個 bite-sized tasks，每個附檔案路徑與驗證指令
F. **驗證**（§F）— 怎麼證明每個能力真的可用
G. **參考來源**（§G）

---

## A. MCP 配置計畫

### A.1 `opencode.json` 放置位置

選擇 **project-level**：`D:\GitClone\_HomeProject\opencode-remote\opencode.json`

理由：
- Project 設定會 commit 進 git，跟 server code 一起版控。
- 但 opencode CLI 啟動時的 cwd 不是 `opencode-remote`，而是 `OPENCODE_DIRECTORY`（即 `D:\GitClone\_HomeProject`）。所以：
  - **首選方案：把 `opencode.json` 放在 `D:\GitClone\_HomeProject\opencode.json`**（cwd 就能直接讀到），但這個目錄不是 git repo。
  - **次選方案：`opencode-remote/opencode.json`，並在 spawn 時透過 `OPENCODE_CONFIG` 環境變數明確指定路徑**（需確認 opencode CLI 是否支援；若不支援，改 symlink 或 copy）。
  - **本計畫採用次選方案 + symlink fallback**：commit 進 `opencode-remote/opencode.json`，啟動腳本 (`start.ps1`) 在 OPENCODE_DIRECTORY 建 symbolic link `D:\GitClone\_HomeProject\opencode.json` → `opencode-remote/opencode.json`。

### A.2 完整 `opencode.json` 內容

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  // 模型與 provider — opencode-remote 後端固定 GPT-5.5
  "provider": "openai",
  "model": "gpt-5.5",
  "small_model": "gpt-5-mini",

  // 工具 permission：edit / bash 對 sensitive 區域要 prompt
  "permission": {
    "edit": {
      "allow": ["**/*"],
      "deny": [
        "**/.env",
        "**/.env.*",
        "**/*service-account*.json",
        "**/.claude-memory/**",     // Claude 端的記憶檔不被 GPT 直接改
        "**/secrets/**"
      ]
    },
    "bash": {
      "allow": [
        "git *",
        "npm *",
        "node *",
        "tsx *",
        "tsc *",
        "ls *",
        "type *",
        "cat *",
        "cd *",
        "powershell -Command *"
      ],
      "deny": [
        "rm -rf *",
        "git push --force *",
        "git reset --hard *",
        "* > .env*",
        "del /f /s /q *"
      ]
    }
  },

  // Step budget — 防止 doom loop
  "agent": {
    "default": { "steps": 50 },
    "subagent": { "steps": 30 }
  },

  // 全 repo 共用的 instruction sources
  // 路徑相對 cwd，cwd = OPENCODE_DIRECTORY = D:\GitClone\_HomeProject
  "instructions": [
    "AGENTS.md",
    "homelab-docs/skills/execution-style/SKILL.md",
    "homelab-docs/skills/completion-checklist/SKILL.md",
    "homelab-docs/skills/plan-before-build/SKILL.md",
    "homelab-docs/skills/agent-design/SKILL.md",
    "homelab-docs/skills/integration-robustness/SKILL.md",
    "homelab-docs/skills/verification-and-evidence/SKILL.md",
    "homelab-docs/skills/root-cause-debugging/SKILL.md",
    "homelab-docs/skills/deployment/SKILL.md",
    "homelab-docs/skills/project-stack-standard/SKILL.md",
    "*/AGENTS.md"
  ],

  // MCP servers
  "mcp": {
    "filesystem": {
      "type": "local",
      "command": [
        "npx", "-y",
        "@modelcontextprotocol/server-filesystem",
        "{env:OPENCODE_DIRECTORY}"
      ],
      "enabled": true,
      "timeout": 10000
    },
    "git": {
      "type": "local",
      "command": ["npx", "-y", "@cyanheads/git-mcp-server"],
      "enabled": true
    },
    "github": {
      "type": "remote",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer {env:GITHUB_TOKEN}"
      },
      "enabled": true,
      "timeout": 10000
    },
    "fetch": {
      "type": "local",
      "command": ["npx", "-y", "mcp-fetch-server"],
      "enabled": true
    },
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "@playwright/mcp"],
      "enabled": false,    // 預設關閉，需要時再開
      "timeout": 30000
    }
  }
}
```

### A.3 每個 MCP server 的選用理由

| Server | 為什麼要 | 取代了什麼 | 風險 |
|--------|---------|-----------|------|
| `filesystem` | 結構化讀寫，比純 bash `ls/cat` 安全（限定 allowed root） | 部分取代 bash 的檔案操作 | npx 啟動成本（首次冷啟 5–10s） |
| `git` | git 操作走結構化 API，避免 shell injection；可列分支、看 status、看 diff | 部分取代 `bash git` | 與 bash git 功能重疊；可選擇只讓 GPT 用 git MCP |
| `github` | issue/PR/comment 直接走 API，不用 web 抓 | 取代 `gh` CLI 的部分用途 | 需 PAT；token 別寫死，走 env var |
| `fetch` | 抓任意 URL 內容（HTML→markdown），給 doc lookup 用 | 部分取代 `websearch` | 同步阻塞，超大頁面會吃記憶體 |
| `playwright` | 真正的瀏覽器自動化（含 home-media、sheet-to-car 的 E2E） | 取代手寫 Playwright 腳本當作 ad-hoc 工具 | 預設關閉以省資源 |

不採用的：
- `@modelcontextprotocol/server-memory`（知識圖譜模型不相容於 markdown memory，見 Q3）
- `@modelcontextprotocol/server-puppeteer`（被 playwright 取代）
- `@modelcontextprotocol/server-everything`（demo 用）

### A.4 內建工具的 permission 對齊

opencode 內建工具不需在 `mcp` 區段設定，但需要在 `permission` 區段約束。已在 A.2 範例中含括。額外注意：

- `webfetch`：opencode 內建工具，會用 OpenAI 的 fetch API。**保留**，但與 `fetch` MCP 行為重疊；建議優先用 MCP（statefuller、可控 timeout）。
- `websearch`：opencode 內建走 Exa；**未設 EXA_API_KEY 時 noop**。Q8 暫不啟用，需要時於 `~/.config/opencode/opencode.json` 加 `"experimental": { "websearch_provider": "exa", "exa_api_key": "..." }`。

### A.5 環境變數

新增到 `D:\GitClone\_HomeProject\opencode-remote\.env`：

```env
# 已有
OPENCODE_DIRECTORY=D:\GitClone\_HomeProject
PORT=9223
OPENCODE_PORT=4096
SESSION_REFRESH_INTERVAL_MS=30000

# 新增（MCP 用）
GITHUB_TOKEN=<personal-access-token>     # 給 mcp/github 用，scopes: repo + read:org
# OPENCODE_CONFIG=...                    # 若要讓 opencode 讀 opencode-remote/opencode.json，啟動時注入
```

`packages/server/src/index.ts` 的 spawn 區段需要把 `GITHUB_TOKEN` 透傳：

```typescript
env: {
  ...process.env,
  OPENCODE_SERVER_PASSWORD: "",
  GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
}
```

---

## B. 專案指引同步

### B.1 instruction 載入順序（opencode 規則）

opencode 從目前 cwd 沿路徑向上累積，第一個命中的同類型檔案勝出。在我們的設定下：

```
opencode 啟動時 cwd = D:\GitClone\_HomeProject
  ├─ AGENTS.md                 ← 一定要建（workspace 級總綱）
  ├─ CLAUDE.md                 ← 不存在於這層；若日後建立會被 opencode 當 fallback
  ├─ <project>/
  │   ├─ AGENTS.md             ← 每個 repo 自帶（per-project rule）
  │   └─ CLAUDE.md             ← Claude 在用的；opencode 也會讀（fallback）
  └─ opencode.json             ← symlink → opencode-remote/opencode.json
```

外加透過 `instructions` glob（見 A.2）把 `homelab-docs/skills/**/SKILL.md` 拉進來。

### B.2 `D:\GitClone\_HomeProject\AGENTS.md`（workspace 級，新建）

這個檔案是「用 opencode 看整個 HomeProject 工作區的入口」。內容應**指向**已存在的 `homelab-docs/CLAUDE.md`，而不是重抄一份。範例骨架：

```markdown
# HomeProject Workspace — AGENTS.md

> opencode (GPT-5.5) loads this file first when working anywhere under `D:\GitClone\_HomeProject\`.

## Single source of truth

The authoritative workspace facts live in `homelab-docs/CLAUDE.md` — read it for:
- Tailscale IPs, RPi/VM/host inventory
- URL routing table (Caddy)
- Shared library policy (`@kevinsisi/ai-core`)
- CI/CD pattern, Docker Hub account
- User preferences (chuangkevin push account, no IPv6, etc.)

This `AGENTS.md` only lists the rules opencode must always honor that aren't already
captured in the per-skill files.

## Identity & attribution

- Backend: GPT-5.5 (via opencode-cli on kevinhome)
- Commit author co-author line: `Co-Authored-By: opencode (gpt-5.5) <noreply@anthropic.com>`
  Do NOT use the Claude Code co-author line — different runtime, different audit trail.
- Push account: `chuangkevin` (matches Claude side)

## Mandatory skills (auto-loaded)

The following SKILL.md files are loaded into context via the `instructions` glob in
`opencode.json` and are MANDATORY:

- `execution-style/SKILL.md` — default execution behavior
- `completion-checklist/SKILL.md` — 10-step finish-up after every change
- `plan-before-build/SKILL.md` — for new features / non-trivial changes
- `agent-design/SKILL.md` — for any multi-agent / tool architecture work
- `integration-robustness/SKILL.md` — for external API / AI calls / retries
- `verification-and-evidence/SKILL.md` — for runtime / CI / CD claims
- `root-cause-debugging/SKILL.md` — for bugs and regressions
- `deployment/SKILL.md` — for Docker / Caddy / release work
- `project-stack-standard/SKILL.md` — for stack / DB / monorepo decisions

When a skill applies, follow it. Don't paraphrase the rules; read the SKILL.md.

## Memory

Memory lives in `homelab-docs/.opencode-memory/`. The index file is
`homelab-docs/.opencode-memory/MEMORY.md`. Read it at session start; write to it when
you learn user/feedback/project/reference facts. See `docs/capability-alignment-plan.md`
section C for format and triggers.

## Subagents

Subagents are defined in `opencode-remote/.opencode/agents/`. Use them per the agent
definitions — they have narrower permission scopes than the primary agent.

## Per-project rules

Each repo MAY have its own `AGENTS.md` overriding or extending these rules. opencode
loads the deepest matching file first, then walks up. Do not duplicate workspace rules
into per-repo files; only add what is genuinely repo-specific.
```

### B.3 Per-project `AGENTS.md` 策略

**規則：** 不複製、只指向 + 加 repo-specific 規則。

每個 repo 加一個薄殼 `AGENTS.md`：

```markdown
# <project-name> — AGENTS.md

> Workspace rules live in `../AGENTS.md`. Skill files live in `../homelab-docs/skills/`.
> This file lists ONLY rules specific to <project-name>.

## Project facts

[3–6 bullet points: stack, port, domain, special build commands]

## Mandatory project-specific skills

[Reference any skills in homelab-docs/skills/ that are mandatory for THIS repo only,
 e.g. sheet-to-car needs `post-helper-8891-adapter` + `sheet-to-car-json-output-contract`]

## Quirks

[Things a fresh agent would trip on — e.g. "test DB must be reset between runs",
 "this project uses Alpine.js, not React"]
```

### B.4 `CLAUDE.md` 與 `AGENTS.md` 共存

| 情境 | opencode 讀什麼 | Claude Code 讀什麼 |
|------|----------------|-------------------|
| Workspace 級總綱 | `D:\GitClone\_HomeProject\AGENTS.md`（新建） | `homelab-docs/CLAUDE.md`（已存在） |
| Per-project 規則 | `<project>/AGENTS.md`（新建薄殼） | `<project>/CLAUDE.md`（已存在） |
| Skills | `homelab-docs/skills/**/SKILL.md`（透過 `instructions` glob） | 同（Claude 也讀同一份） |
| 記憶 | `homelab-docs/.opencode-memory/`（新建） | `homelab-docs/.claude-memory/`（已存在） |

**雙寫風險防護：**
- workspace 與 per-project AGENTS.md 都明確標「具體事實見 CLAUDE.md / homelab-docs」，避免 drift。
- 週期性 audit：`completion-checklist` 補一條「若 PR 改了 CLAUDE.md 工作流程描述，要同步檢查 AGENTS.md 是否需要更新」。

### B.5 多專案要不要再開 server？

**不需要。** 一個 server (cwd=`_HomeProject`) 即可，因為：
- opencode 內部 instruction layering 會根據當下任務的工作目錄沿路徑向上爬。
- 使用者切換專案只需在 chat 裡 `cd <project>` 或 `bash` 工具明示。
- 多 server 會吃 4096+ port、增加 watchdog 負擔，且 session 列表互不互通。

---

## C. 記憶系統設計

### C.1 為什麼走純檔案而非 MCP

決策見 §1 Q3。額外論點：

- Claude Code auto-memory 目前是 markdown 檔案（已被 user 大量採用）。如果 opencode 走知識圖譜 MCP，等於兩個 AI 各自一份不互通的 memory。
- 純檔案讓兩邊互讀／互寫一致，且 user 自己也能 `grep` 翻找。
- opencode 沒有 native 「auto-memory」概念，但它的 instruction layering 能把 `MEMORY.md` 當 instruction 強制注入。

### C.2 目錄結構

```
D:\GitClone\_HomeProject\homelab-docs\.opencode-memory\
├── MEMORY.md                      ← 索引（opencode 每次啟動讀取，<200 行）
├── user_role.md                   ← user-type 範例
├── user_preferences.md
├── feedback_testing.md            ← feedback-type 範例
├── feedback_commits.md
├── project_<name>_status.md       ← project-type
├── reference_<system>.md          ← reference-type
└── _archive/                      ← 過期但保留審視
```

格式 frontmatter（與 Claude auto-memory 一致）：

```markdown
---
name: <memory name>
description: <one-line description for relevance matching>
type: user | feedback | project | reference
---

<memory content>
```

`MEMORY.md` 是「目錄頁」，每行 ≤150 字元：

```markdown
# opencode Memory Index

- [User role](user_role.md) — Kevin owns HomeProject homelab; senior dev; multi-AI workflow
- [Push account](user_preferences.md) — chuangkevin for kevinsisi org pushes
- [Testing rule](feedback_testing.md) — integration tests must hit real DB after Q1 incident
- ...
```

### C.3 寫入時機（在 AGENTS.md 中明示）

在 workspace `AGENTS.md` 中加一個 `## Memory` 章節，內容**直接抄** `D:\GitClone\_HomeProject\opencode-remote\.claude\worktrees\elated-mahavira-e51512\CLAUDE.md` 中的「auto memory」段落（即此本檔案開頭那段），但改成 opencode 版本：

- **user-type**：使用者透露身分／角色／偏好／知識
- **feedback-type**：被糾正、或被「對！」確認某非顯然做法
- **project-type**：誰在做什麼、為什麼、deadline；**相對日期一定轉絕對日期**
- **reference-type**：外部系統位置（Linear、Grafana、本機 Pi-hole UI 等）

不存：可從程式碼／git log/ CLAUDE.md 推得的事實。

### C.4 讀取時機

- **每次 session 啟動**：opencode load `MEMORY.md`（透過 `instructions: ["homelab-docs/.opencode-memory/MEMORY.md"]` glob）。
- **使用者明確要求**：「我之前說過…」、「你還記得…」 → 用 `read` / `grep` 工具找對應檔案。
- **使用記憶前先 verify**：如果記憶提到具體 file path / function name，先 `glob` / `grep` 確認還存在。

### C.5 與 Claude 端 memory 的同步

選擇 **不自動同步**，理由：
- Claude 與 opencode 是不同 runtime，session 不一樣，所學會的東西可能彼此衝突。
- 強制同步會掩蓋衝突。
- 但「使用者 ground truth 偏好」應跨 AI 一致，所以：

**規則：** 若一條 memory 屬於 `user` 或 `reference` type，存完自家後，**順手** 也寫一份到對方目錄（或追加 `cross_ai: true` 旗標）。`feedback` / `project` type 各自獨立。

實作於 §E Task 11（pre-commit hook 提示）。

---

## D. 工作流程對齊

### D.1 Subagent 設計

新建 `D:\GitClone\_HomeProject\opencode-remote\.opencode\agents\`，放以下檔案。每個 agent 都是 markdown + YAML frontmatter，opencode 會以 filename 作為 agent ID。

#### `.opencode/agents/explore.md`

```markdown
---
description: Read-only research agent. Use for codebase exploration, finding files, grep, understanding existing patterns. Cannot edit, cannot run mutating commands.
mode: subagent
model: gpt-5-mini
temperature: 0.2
steps: 20
permission:
  edit: deny
  bash:
    allow: ["git log *", "git status", "git diff *", "git show *", "ls *", "type *", "cat *", "find *"]
    deny: ["*"]
color: blue
---

You are the Explore agent. Your single job is to find and report.

- Use `read`, `grep`, `glob` freely. Use `bash` only for read-only git/ls/cat.
- Quote exact file paths and line numbers in your report.
- Do NOT propose code changes. Do NOT speculate without grounding in files.
- Output is a self-contained briefing. Cap at 600 words unless caller asks for more.
```

#### `.opencode/agents/plan.md`

```markdown
---
description: Architecture / planning agent. Produces step-by-step implementation plans with file paths, but writes no code. Read-only on the codebase.
mode: subagent
model: gpt-5.5
temperature: 0.3
steps: 30
permission:
  edit: deny
  bash:
    allow: ["git log *", "git status", "git diff *", "ls *", "cat *"]
    deny: ["*"]
color: purple
---

You are the Plan agent. You translate a goal + spec into a concrete bite-sized plan.

Honor `homelab-docs/skills/plan-before-build/SKILL.md` strictly. Output format:

1. **Files to touch** — exact paths
2. **Steps** — numbered, each with file + change description + verify command
3. **Risks** — known unknowns
4. **Rollback** — how to undo

Write the plan to `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` and return its path.
Do NOT begin implementation.
```

#### `.opencode/agents/implement.md`

```markdown
---
description: Implementation agent. Has full edit + bash permission within the allowed scope. Follows plan tasks one at a time, commits per logical unit.
mode: subagent
model: gpt-5.5
temperature: 0.4
steps: 80
permission:
  edit:
    allow: ["**/*"]
    deny: ["**/.env*", "**/secrets/**", "**/.claude-memory/**"]
  bash:
    allow: ["git *", "npm *", "node *", "tsx *", "tsc *", "ls *", "cat *", "powershell -Command *"]
    deny: ["rm -rf *", "git push --force *", "git reset --hard *"]
color: green
---

You are the Implement agent.

- Receive a task (one bite-sized step from the plan).
- Make the smallest change that satisfies the step.
- Run the verify command.
- Commit with conventional message + opencode co-author line (see workspace AGENTS.md).
- Return: files changed, commit SHA, verify output.

Honor `completion-checklist/SKILL.md`. If the change is the last in a logical unit,
also push (per workspace push-account rule).
```

#### `.opencode/agents/verify.md`

```markdown
---
description: Verification agent. Runs tests, builds, type-checks, smoke-tests deployments. Cannot edit code; reports failures with logs.
mode: subagent
model: gpt-5-mini
temperature: 0.1
steps: 15
permission:
  edit: deny
  bash:
    allow: ["npm test*", "npm run *", "tsc *", "tsx *", "node *", "curl *", "git status", "git log *"]
    deny: ["git push *", "git commit *", "rm *"]
color: yellow
---

You are the Verify agent. Run the verification commands the caller specified, capture
output, and report PASS/FAIL plus relevant excerpts.

If something fails, do NOT try to fix it — return the failure to the caller. The caller
decides whether to dispatch Implement again.
```

#### `.opencode/agents/reviewer.md`

```markdown
---
description: Code review agent. Reads diffs and flags issues. Read-only.
mode: subagent
model: gpt-5.5
temperature: 0.2
steps: 15
permission:
  edit: deny
  bash:
    allow: ["git diff *", "git log *", "git show *", "ls *", "cat *"]
    deny: ["*"]
color: red
---

You are the Reviewer agent. Given a diff or a commit range, review for:

1. Security (input validation, injection, leaked secrets)
2. Correctness (logic errors, off-by-one, null handling)
3. Style consistency (does it match nearby code?)
4. Test coverage (is there a test for the new behavior?)
5. Spec / memory updates (per `completion-checklist/SKILL.md`)

Output a punch-list. Do not propose code; describe issues so the Implement agent or
human can fix them.
```

### D.2 Completion checklist 在 opencode 的實現

不重寫 checklist 內容；改成在 workspace `AGENTS.md` 強制要求：

> Before reporting any code change as complete, you MUST follow `homelab-docs/skills/completion-checklist/SKILL.md`. Do not paraphrase. Re-read the file each time the rule is triggered.

並在 `.opencode/agents/implement.md` 的 system prompt 也加同一句。

額外保險：在 `.githooks/pre-commit`（已存在於 homelab-docs setup）加一條檢查 — 「若 commit message 沒有 co-author line，prompt 警告」，這條對 opencode + Claude 都生效。

### D.3 多 agent / 平行任務

opencode 的 agent loop 在 `prompt.ts` 已支援平行 tool calls（透過 sub-task parts）。實作層面：

- **單一複雜任務**：primary agent 用 `dispatch_subagent` tool（opencode 內建）派 1–N 個 subagent（如 Explore × 3 跑不同搜尋 + Plan × 1 整合）。
- **使用者請求平行**：如「同時看這三個 repo 最近一週改了什麼」 → primary agent 一次派三個 Explore subagent。

`AGENTS.md` 加一條：

> When tasks are independent (different repos, different files, different verification scopes), dispatch them as parallel subagents. When tasks are sequential (same file, dependent results), keep them in the primary agent.

### D.4 Worktree isolation

opencode 沒有內建 worktree 概念，但 `bash` 工具支援 `git worktree add`。策略：

- **小改動（單一 repo、< 5 檔案）**：直接在 main checkout 改。
- **跨多 repo 大改、或會 break 主分支**：在 `D:\GitClone\_HomeProject\<repo>\.opencode\worktrees\<task-id>` 建 worktree。
- **Implement agent** 收到任務時，若任務描述含「worktree:」prefix 或 task list 的 metadata 標 `isolation: worktree`，就先建 worktree、cd 過去再開工。
- 完成後 `completion-checklist` 步驟 8.0「worktree convergence」生效：merge 回主分支 → 刪 worktree。

`AGENTS.md` 加：

> For changes that touch ≥3 files in ≥2 repos, prefer `git worktree add` to isolate the work.
> Convergence: rebase / merge back into main, delete the worktree, confirm clean before
> reporting completion.

### D.5 對齊 Claude Cowork 的「dispatch」流程

Claude Code 的 Cowork dispatch 流程是「主 agent → 拆任務 → 平行送到 cloud worktree → 收回」。opencode 沒有 cloud 端，但同機 worktree + subagent 可模擬：

| Cowork 階段 | opencode 對應 |
|-------------|--------------|
| Plan splitting | Primary 用 `plan` subagent 產生 task list |
| Dispatch | Primary 為每個 task call `implement` subagent (mode: subagent) |
| Per-task isolation | 每個 task 在自己的 worktree（D.4） |
| Aggregation | Primary 收集 subagent 回傳的 commit SHA / 結果 |
| Review | 派一個 `reviewer` subagent 看每個 worktree 的 diff |
| Merge | Primary 在 review 通過後執行 merge |

**限制：** 同機平行跑會搶 CPU / port；建議單台機器同時 ≤2 個 implement subagent。設於 `agent.subagent.steps` 之外，由 user 視情況控制。

---

## E. 實作任務（writing-plans 格式）

> **執行模式：** 採 inline execution（不分派 subagent）— 因為這個 plan 本身在 bootstrap subagent 機制，雞生蛋蛋生雞，第一輪要先用 primary agent 跑完。

### Task 1: 建立 workspace AGENTS.md

**Files:**
- Create: `D:\GitClone\_HomeProject\AGENTS.md`

**Step 1.1** — 把 §B.2 的 AGENTS.md 骨架寫入該路徑。
**Step 1.2** — `git status` — 注意這個目錄不是 git repo，所以這個檔案不會被任何 repo 追蹤。**接受這個事實**（或之後另外起一個 `_HomeProject-config` repo 收 workspace 級檔案，本 plan 不處理）。
**Step 1.3** — 確認 opencode session 重啟後能讀到它（讀 `/global/health` → 新 session → 問「workspace AGENTS.md 第一段是什麼」）。

### Task 2: 建立 per-project AGENTS.md（薄殼）

**Files:** 對每個 repo create 一個 `AGENTS.md`，內容依 §B.3 模板。優先順序（從常用開始）：
1. `opencode-remote/AGENTS.md`
2. `mind-diary/AGENTS.md`
3. `sheet-to-car/AGENTS.md`（注意它在 `_car-maintain/sheet-to-car`）
4. `home-media/AGENTS.md`
5. `project-bridge/AGENTS.md`
6. `key-manager/AGENTS.md`
7. `ai-core/AGENTS.md`
8. 其餘 repos 之後再補

**Step 2.1** — 先做 1–2 個試水溫，commit + push 到該 repo。
**Step 2.2** — 開新 opencode session 在該 repo 中問「請列出這個 repo 的 AGENTS.md 第一個 quirk」，驗證載入。
**Step 2.3** — 模板對其餘 repo 複製套用。每個 commit 一次。

### Task 3: 建立 `opencode.json`（project-level）

**Files:**
- Create: `D:\GitClone\_HomeProject\opencode-remote\opencode.json`

**Step 3.1** — 把 §A.2 的 JSON 完整寫入。
**Step 3.2** — 修 `start.ps1` 與 `start-hidden.ps1`：在 spawn opencode-cli 前，建 symbolic link：
   ```powershell
   $WorkspaceConfig = "D:\GitClone\_HomeProject\opencode.json"
   if (-not (Test-Path $WorkspaceConfig)) {
       New-Item -ItemType SymbolicLink -Path $WorkspaceConfig -Target "D:\GitClone\_HomeProject\opencode-remote\opencode.json"
   }
   ```
   （需 admin 權限或開啟 Developer Mode；若不行則改 `Copy-Item` 並警告 drift 風險。）
**Step 3.3** — 重啟 server (`.\stop.ps1; .\start-hidden.ps1`)。
**Step 3.4** — 驗證：
   ```powershell
   curl http://localhost:4096/global/health   # 應 healthy
   # 開 session 問「列出目前掛載的 MCP 工具」 — 應看到 filesystem/git/github/fetch
   ```

### Task 4: 安裝 + 驗證 5 個 MCP server

**Step 4.1** — 預先 `npx` 一次每個 server 確認下載成功（避免 session 內首次延遲）：
```powershell
npx -y @modelcontextprotocol/server-filesystem --help
npx -y @cyanheads/git-mcp-server --help
npx -y mcp-fetch-server --help
# GitHub MCP uses GitHub's official remote endpoint: https://api.githubcopilot.com/mcp/
# playwright 預設 disabled，先不裝
```
**Step 4.2** — 為 GitHub MCP 申請 PAT（GitHub → Settings → Developer settings → Tokens (classic)），scopes：`repo`, `read:org`. 寫進 `opencode-remote/.env` 的 `GITHUB_TOKEN`。
**Step 4.3** — 不需要修改 server code；`.env` 會載入 `process.env`，並由 `opencode serve` child process 繼承 `GITHUB_TOKEN`。
**Step 4.4** — 重啟 server，session 內試 `「mcp/git: list branches in opencode-remote」` 跟 `「mcp/github: open issues in kevinsisi/mind-diary」`，驗證兩者都能呼叫成功。

### Task 5: 建立記憶系統目錄結構

**Files:**
- Create: `D:\GitClone\_HomeProject\homelab-docs\.opencode-memory\MEMORY.md`
- Create 3 個示範檔：`user_preferences.md`, `feedback_no_force_push.md`, `reference_caddyfile.md`

**Step 5.1** — `MEMORY.md` 初始內容：
```markdown
# opencode Memory Index

- [User preferences](user_preferences.md) — chuangkevin push, no IPv6, 繁體中文 UI
- [No force push](feedback_no_force_push.md) — never `git push --force` to main/master
- [Caddyfile](reference_caddyfile.md) — RPi /home/kevin/DockerCompose/caddy/Caddyfile
```
**Step 5.2** — 三個示範檔內容依 §C.2 frontmatter 格式。
**Step 5.3** — 在 `homelab-docs/.gitignore` 確認 `.opencode-memory/` 是否要進 git。**建議要進 git**（與 `.claude-memory/` 一致），因為跨機 sync 需要。
**Step 5.4** — 從 opencode session 問「我的 push account 是什麼？」確認能從 memory 找到。

### Task 6: 在 workspace AGENTS.md 註冊 memory 規則

**Step 6.1** — 在 §B.2 的 AGENTS.md 已經有 `## Memory` 章節，但內容只是指向。改成完整版（直接抄此本檔案開頭的 system reminder「auto memory」段，但路徑改成 `.opencode-memory/`）。
**Step 6.2** — Commit 到 `homelab-docs`（如果 workspace AGENTS.md 留在 `_HomeProject` root 就無法 commit；改放 `homelab-docs/AGENTS.md` 並在 workspace symlink 過去 — 詳見 Task 7）。

### Task 7: 解決 workspace AGENTS.md 的 git 歸屬

**問題：** `D:\GitClone\_HomeProject\AGENTS.md` 不在任何 repo 內。
**解法：**
- 把真正內容放 `homelab-docs/AGENTS.md`（commit 到 homelab-docs repo）
- 在 `D:\GitClone\_HomeProject\` 建 symlink: `AGENTS.md → homelab-docs\AGENTS.md`
- `start.ps1` 加判斷自動建立 symlink（與 Task 3.2 同方法）

**Step 7.1** — `mv D:\GitClone\_HomeProject\AGENTS.md D:\GitClone\_HomeProject\homelab-docs\AGENTS.md`
**Step 7.2** — `New-Item -ItemType SymbolicLink ...`
**Step 7.3** — Commit `homelab-docs/AGENTS.md`，push。

### Task 8: 建立 5 個 subagent 定義檔

**Files:**
- Create: `D:\GitClone\_HomeProject\opencode-remote\.opencode\agents\explore.md`
- Create: `D:\GitClone\_HomeProject\opencode-remote\.opencode\agents\plan.md`
- Create: `D:\GitClone\_HomeProject\opencode-remote\.opencode\agents\implement.md`
- Create: `D:\GitClone\_HomeProject\opencode-remote\.opencode\agents\verify.md`
- Create: `D:\GitClone\_HomeProject\opencode-remote\.opencode\agents\reviewer.md`

**Step 8.1** — 把 §D.1 的 5 個 markdown 完整內容寫入。
**Step 8.2** — 同樣面臨 cwd 問題（opencode 啟動 cwd = `_HomeProject`，不是 `opencode-remote`）。`.opencode/agents/` 也需要 symlink 或放 `_HomeProject` 級別。**決定：放 `homelab-docs/.opencode/agents/`，workspace 建 symlink。** 與 AGENTS.md 同模式。
**Step 8.3** — 重啟 server，session 內試 `「dispatch explore subagent: list recent commits in mind-diary」` 看 subagent 是否被載入並執行。

### Task 9: 把 Skills 拉進 instructions glob

**Step 9.1** — `opencode.json` 的 `instructions` 已含 `homelab-docs/skills/**/SKILL.md`（A.2）。
**Step 9.2** — 驗證：opencode session 開 `「請列出當前載入的 mandatory skill 名稱」` — 應看到 9 個 skill。
**Step 9.3** — 若 token 太爆，把不常用的 skill（如 `key-pool-standard`、`8891-form-schema`）改為 lazy load — 在 `AGENTS.md` 註明「以下 skill 在被觸發時才讀」，從 glob 移除，靠 `read` 工具按需載入。

### Task 10: 完成 checklist hook 強化

**Step 10.1** — 確認 `homelab-docs/skills/completion-checklist/SKILL.md` 對 opencode 適用（檢查是否有 Claude-only 字樣）。
**Step 10.2** — 在 `.githooks/pre-commit` 加 co-author line 檢查：
```bash
# Pseudocode
if commit_msg lacks "Co-Authored-By:":
    warn "Missing co-author line. opencode should sign as 'opencode (gpt-5.5)', Claude as 'Claude Opus 4.7'"
```
**Step 10.3** — 兩個 AI 各跑一次小 commit，確認 hook 正常 prompt。

### Task 11: cross-AI memory sync rule

**Step 11.1** — 在 `homelab-docs/AGENTS.md` 與 `homelab-docs/CLAUDE.md` 都加 `## Cross-AI memory sync` 段：
> When you save a `user` or `reference` type memory, also write it to the other AI's memory directory. `feedback` and `project` types stay AI-specific (different runtimes may have different mistakes).
**Step 11.2** — 加一個示範：把 `chuangkevin` push account 偏好同時寫進 `.opencode-memory/user_preferences.md` 與 `.claude-memory/user_preferences.md`，內容一致。

### Task 12: 文件 + 驗證

**Step 12.1** — 在 `opencode-remote/README.md` 加一節「Capability alignment with Claude Code」指向本檔案。
**Step 12.2** — 跑 §F 的三個驗證任務，截圖 / log 貼回 spec。
**Step 12.3** — Commit 全部變更，push 到 `kevinsisi/opencode-remote`。
**Step 12.4** — 在 `homelab-docs/CLAUDE.md` 加一行「opencode 端能力對齊 plan 見 `opencode-remote/docs/capability-alignment-plan.md`」。

---

## F. 驗證

§0.3 已列三個 acceptance test。額外 sanity check：

### F.1 MCP 工具可見性

```
opencode session 內：
> 列出目前可用的所有工具，分內建與 MCP

Expected: 內建 12 個 + mcp/filesystem.* + mcp/git.* + mcp/github.* + mcp/fetch.*
```

### F.2 Subagent 派發

```
> 派一個 explore subagent 看 home-media 最近 5 個 commit 的 message，
> 同時派一個 explore subagent 看 mind-diary 同樣的東西，最後合併報告

Expected: 兩個 subagent 平行執行，回傳報告含 commit SHA + 訊息
```

### F.3 Memory 引用

```
> 我的 GitHub push account 是什麼？

Expected: opencode 從 .opencode-memory/user_preferences.md 找到
"chuangkevin"，並在回答中明確 cite 來源檔案
```

### F.4 Permission 邊界

```
> 把 .env 裡的 GITHUB_TOKEN 改成 ABC

Expected: opencode 拒絕（permission.edit.deny 命中 **/.env*）
並建議使用者自己改
```

### F.5 完成檢核

```
在 opencode 中改一個簡單 typo，請 opencode 自己 commit。

Expected: commit message 含 "Co-Authored-By: opencode (gpt-5.5) ..."，
且 opencode 主動提及「這次改動需要更新 memory / spec / push 嗎？」
（即 completion-checklist 觸發）
```

---

## G. 參考來源

### G.1 已讀過的本機檔案

- `D:\GitClone\_HomeProject\opencode-remote\CLAUDE.md` — 現況、Windows 啟動、Caddy gzip、HTML injection 限制
- `D:\GitClone\_HomeProject\opencode-remote\package.json` — workspace 結構、Node 22
- `D:\GitClone\_HomeProject\opencode-remote\.env` — `OPENCODE_DIRECTORY=D:\GitClone\_HomeProject`
- `D:\GitClone\_HomeProject\opencode-remote\openspec\config.yaml` + `specs\session-proxy\spec.md` — 現有 capability 邊界
- `D:\GitClone\_HomeProject\opencode-remote\docs\superpowers\plans\2026-04-20-redesign.md` — 上次 redesign 的 task 結構
- `D:\GitClone\_HomeProject\homelab-docs\CLAUDE.md` — workspace 級事實（IP、Caddy、Skill activation 表）
- `D:\GitClone\_HomeProject\homelab-docs\AGENT_RULES.md` — 規則優先序、Gemini reviewer
- `D:\GitClone\_HomeProject\homelab-docs\opencode-agent-analysis.md` — opencode runtime 內部觀察
- `D:\GitClone\_HomeProject\homelab-docs\skills\agent-design\SKILL.md`
- `D:\GitClone\_HomeProject\homelab-docs\skills\execution-style\SKILL.md`
- `D:\GitClone\_HomeProject\homelab-docs\skills\completion-checklist\SKILL.md`
- `D:\GitClone\_HomeProject\homelab-docs\skills\plan-before-build\SKILL.md`
- `D:\GitClone\_HomeProject\homelab-docs\skills\skill-creator\SKILL.md`
- `D:\GitClone\_HomeProject\superpowers\skills\brainstorming\SKILL.md`
- `D:\GitClone\_HomeProject\superpowers\skills\writing-plans\SKILL.md`

### G.2 opencode 官方文件（透過 WebFetch）

- https://opencode.ai/docs/config — top-level fields、`instructions` glob 支援、MCP schema
- https://opencode.ai/docs/mcp-servers — `local` vs `remote`、`environment`、`headers`、`oauth`、`timeout`
- https://opencode.ai/docs/agents — `.opencode/agents/*.md`、frontmatter `description / mode / model / temperature / steps / permission`
- https://opencode.ai/docs/rules — `AGENTS.md` primary、`CLAUDE.md` fallback、loading order
- https://opencode.ai/docs/tools — built-in tools 清單

### G.3 MCP server packages

- `@modelcontextprotocol/server-filesystem` — npm 套件，受限 root 的檔案 R/W
- `@cyanheads/git-mcp-server` — npm 套件，結構化 git 操作
- GitHub official remote MCP — `https://api.githubcopilot.com/mcp/` with `GITHUB_TOKEN` bearer auth
- `mcp-fetch-server` — npm 套件，URL → markdown/text/json
- `@playwright/mcp` — 瀏覽器自動化（預設 disabled）

### G.4 相關 Claude Code 概念對照

- Claude `Cowork` ≈ opencode subagent + worktree
- Claude `Dispatch` ≈ opencode primary agent → 多 subagent 派發
- Claude `Skills` (built-in) ≈ opencode `skill` 工具 + `instructions` glob
- Claude `auto-memory` ≈ 本計畫 §C 純檔案版

---

## H. 待使用者決定的問題（請回答後再進入 §E）

> 這份是 §1 的精簡版，方便快速回覆。

1. **Q1**：`opencode.json` 放 `opencode-remote/` repo 內 + symlink？OK 嗎？或想放別處？
2. **Q2**：保持單一 server (cwd=`_HomeProject`)，還是想做 per-repo server？
3. **Q3**：純檔案 memory，OK 嗎？或要再掛 memory MCP？
4. **Q4**：`Co-Authored-By: opencode (gpt-5.5) <noreply@anthropic.com>` 這個 email domain 可以嗎？還是要換 noreply@openai.com / noreply@kevinsisi.com？
5. **Q5**：5 個 subagent (`explore`, `plan`, `implement`, `verify`, `reviewer`) — 數量與職責 OK 嗎？
6. **Q6**：直接 reuse `homelab-docs/skills/` 而不 fork — 確認 OK？
7. **Q7**：worktree workflow「鼓勵但不強制」— 還是要強制？
8. **Q8**：`websearch` 暫不啟用 — 還是想直接申請 Exa key？
9. **延伸**：`GITHUB_TOKEN` 寫進 `opencode-remote/.env`（已 .gitignore）— 還是改放 `homelab-docs/key-manager` 統一管理？
10. **延伸**：subagent 同時平行上限要設定嗎？預設 ≤ 2 個 implement 並行。

回覆後我會（A）依答覆修正本文件、（B）開始執行 §E Task 1–12。
