# Desktop Caddy for opencode-remote

Emergency private/Tailscale replacement for the RPi Caddy route:

- `opencode.sisihome.org` -> `100.83.112.20:443`
- Caddy on kevinhome -> `host.docker.internal:9223`

Required environment variables:

- `CF_API_TOKEN`: Cloudflare token with `Zone:DNS:Edit` for `sisihome.org`
- `ACME_EMAIL`: optional, defaults to `kevin950805@gmail.com`

Start:

```powershell
$env:CF_API_TOKEN = "<token>"
docker compose up -d --build
```

DNS cutover:

```powershell
$env:CF_API_TOKEN = "<token>"
.\set-opencode-dns.ps1
```

`opencode.sisihome.org` may intentionally have more than one A record. HomeProject
keeps dual A records for cross-account Tailscale sharing because a shared device
can have a different `100.x` address in the other account's tailnet. Do not
dedupe or delete sibling A records unless Kevin explicitly says to remove that
account's access.

Do not commit tokens or create a tracked `.env` file with secrets.
