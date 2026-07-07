# Car Site

- 2026-06-10: `car-site` AI concierge now persists the current browser tab/session conversation in `sessionStorage` under `car-site-chat-session`, including messages and exchange count. This is intentionally session-scoped, not permanent DB storage.
- 2026-06-10: `src/pages/api/chat.ts` uses the configured `settings.lineUrl` in the AI prompt and appends a LINE CTA as a backend fallback for car inquiry/recommendation contexts when a valid LINE URL is configured.
- 2026-06-10: Commit `e619755` (`feat: persist chatbot conversation context`) was pushed to `origin/main`; `npm run build` passed with only pre-existing warnings/hints.
