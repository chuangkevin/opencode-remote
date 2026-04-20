# deployment-wiring

## Why

The proxy works end-to-end locally (cross-browser sync verified in commit
`1f23077`), but it is not yet part of the homelab deployment surface:

1. `opencode.sisihome.org` is not wired up in the RPi Caddyfile — external
   devices cannot reach the proxy over HTTPS/Tailscale.
2. The proxy does not auto-start when `kevinhome` boots. The user has to
   click `start.ps1` manually after every reboot.

Both are routine wiring tasks, not architecture work.

## What Changes

- Add a Caddy site block for `opencode.sisihome.org` → `http://kevinhome:9223`
  on the RPi (hostname reachable via Tailscale).
- Add a Windows Task Scheduler entry on `kevinhome` that runs `start.ps1`
  at user logon, so the proxy is running whenever the machine is on.

## Non-Goals

- Public internet exposure (deployment stays inside Tailscale).
- Multi-user auth or ACL.
- Changes to the proxy code itself.

## Success Criteria

- Navigating to `https://opencode.sisihome.org/` from a Tailscale-connected
  device redirects to the active session and shows the OpenCode UI.
- After rebooting `kevinhome` and logging in, `http://kevinhome:9223/`
  responds with a 302 within ~30 seconds of login (no manual step).

## Notes for the implementer

- RPi hostname: previously reachable; at time of writing SSH to RPi was
  failing — verify Tailscale / power state before editing Caddyfile.
- Task Scheduler gotcha: `opencode.cmd` must be on `PATH` for the task.
  If `npm global` path isn't inherited, set `$env:PATH` in `start.ps1` or
  use the full path to `node.exe` and the compiled `dist/index.js`.
- After wiring Caddy, confirm the URL still redirects correctly when
  accessed via the public-facing hostname (not just localhost).
