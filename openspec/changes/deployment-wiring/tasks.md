# Tasks — deployment-wiring

## 1. Caddy on RPi

- [ ] 1.1 Confirm Tailscale / SSH connectivity to the RPi that runs the
      Caddyfile (previous session had SSH failing; verify with user).
- [ ] 1.2 Add site block to the Caddyfile:
      ```
      opencode.sisihome.org {
        reverse_proxy kevinhome:9223
      }
      ```
      (Use whichever Caddy config style matches existing entries — look at
      a sibling service like `openspec.sisihome.org` as reference.)
- [ ] 1.3 Reload Caddy (`systemctl reload caddy` or equivalent).
- [ ] 1.4 From a Tailscale-connected device, verify
      `https://opencode.sisihome.org/` redirects to the active session and
      the OpenCode UI loads.

## 2. Auto-start on `kevinhome`

- [ ] 2.1 Decide between Task Scheduler (simpler) and NSSM-wrapped Windows
      Service (more robust). Default recommendation: Task Scheduler.
- [ ] 2.2 Create a task that runs at user logon:
      - Program: `powershell.exe`
      - Arguments: `-NoProfile -ExecutionPolicy Bypass -File "D:\Projects\_HomeProject\opencode-remote\start.ps1"`
      - Run only when user is logged on (not as SYSTEM, so `opencode` CLI on user PATH works)
- [ ] 2.3 Test by logging out and back in; verify `curl http://localhost:9223/`
      returns 302 within ~30 seconds.
- [ ] 2.4 If `opencode.cmd` is not found in the Task Scheduler environment,
      amend `start.ps1` to prepend the npm global path to `$env:PATH`
      (typically `$env:APPDATA\npm`).

## 3. Verification

- [ ] 3.1 Open `https://opencode.sisihome.org/` in two different browsers
      (or one regular + one private window). Confirm both land on the
      same URL and show the same session with the same conversation.
- [ ] 3.2 Reboot `kevinhome`. Log in. Wait 30 seconds. Navigate to the URL
      from a separate device. Confirm it works without any manual action
      on `kevinhome`.
- [ ] 3.3 Update `CLAUDE.md` — mark the two pending items as done.
