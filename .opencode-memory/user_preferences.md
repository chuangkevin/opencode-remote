---
name: user_preferences
description: Durable user preferences for HomeProject opencode sessions.
type: user
---

- Kevin prefers Traditional Chinese for user-facing text.
- Kevin's GitHub push account for repos under `kevinsisi` is `chuangkevin`.
- opencode-authored commits should use `Co-Authored-By: Kevin-AI <kevin950805@gmail.com>`.
- Prefer Tailscale and free/self-hosted options where feasible.
- When local setup/config is missing, prompt for user-provided values and let
  `opencode-remote` write local config instead of only reporting that the system
  cannot start.
- `opencode-remote` should be distributable with one command; startup scripts
  must prepare local config, build, and start without requiring manual setup.
- Do not include or preserve user-level Pencil MCP in the shared
  `opencode-remote` runtime config.
- GitHub MCP should be disabled when `GITHUB_TOKEN` is blank; local MCP startup
  should allow enough timeout for first-run `npx` package resolution.
- For HomeProject services, a requested domain does not imply public Internet
  exposure. Unless Kevin explicitly says to make a service public, treat the
  domain as private/Tailscale/testing-only. Public exposure requires an explicit
  request and sheet-to-car-level hardening before adding Cloudflare Tunnel or
  other Internet-facing routing.
- For HomeProject/opencode development, once modifications are complete and the
  relevant tests/build/smoke checks pass, commit and push immediately. Do not ask
  for separate push permission unless Kevin explicitly says not to commit/push or
  a safety blocker applies.
