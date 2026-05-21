function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderCompactShell(sessionID: string): string {
  const id = escapeAttr(sessionID);
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="theme-color" content="#0f0f10" />
  <title>OpenCode</title>
  <link rel="stylesheet" href="/c/static/compact.css" />
  <script src="/c/static/marked.min.js"></script>
</head>
<body data-session-id="${id}">
  <div class="app">
    <header class="app-header">
      <a class="header-back" href="/remote-sessions">← Sessions</a>
      <button class="header-title" id="titleBtn" type="button" title="點擊重新命名">
        <span id="titleText">…</span>
      </button>
      <input class="header-title-input" id="titleInput" type="text" hidden />
      <div class="header-spacer"></div>
      <button class="model-chip" id="modelBtn" type="button">
        <span class="dot"></span>
        <span id="modelName">…</span>
        <span class="variant" id="modelVariant"></span>
      </button>
      <button class="header-fs-btn" id="fsBtn" type="button" aria-label="全螢幕">⛶</button>
      <button class="header-more" id="moreBtn" type="button" aria-label="more">⋯</button>
    </header>

    <div class="messages" id="messages"></div>

    <div class="scroll-chip" id="scrollChip" hidden>↓ <span id="scrollChipCount">0</span> 則新訊息</div>

    <div class="attach-row" id="attachRow" hidden></div>

    <div class="input-bar">
      <button class="icon-btn" id="attachBtn" type="button" aria-label="附圖">📎</button>
      <input type="file" id="fileInput" accept="image/*" multiple hidden />
      <textarea class="compose" id="compose" placeholder="輸入訊息..." rows="1"></textarea>
      <button class="icon-btn stop-btn" id="stopBtn" type="button" aria-label="停止" hidden>■</button>
      <button class="icon-btn send-btn" id="actionBtn" type="button" aria-label="送出">▶</button>
    </div>

    <div class="picker" id="picker" hidden></div>
    <div class="toast" id="toast" hidden></div>
  </div>
  <script type="module" src="/c/static/compact.js"></script>
</body>
</html>`;
}
