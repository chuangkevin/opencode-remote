# Ensure private sisihome.org service hostnames use kevinhome as the entrypoint.
# This creates/updates exact A records so they override the RPi wildcard while
# preserving sibling records used for cross-account Tailscale sharing.

$ErrorActionPreference = "Stop"

$zoneName = "sisihome.org"
$targetIp = "100.83.112.20"
$apiBase = "https://api.cloudflare.com/client/v4"

$hostnames = @(
    "portainer.sisihome.org",
    "lunch.sisihome.org",
    "radio.sisihome.org",
    "code.sisihome.org",
    "readflix.sisihome.org",
    "portal.sisihome.org",
    "wishlist.sisihome.org",
    "onshape.sisihome.org",
    "designbridge.sisihome.org",
    "photo.sisihome.org",
    "bus.sisihome.org",
    "blog.sisihome.org",
    "pihole.sisihome.org",
    "agents.sisihome.org",
    "autospec.sisihome.org",
    "github.sisihome.org",
    "stock.sisihome.org",
    "car.sisihome.org",
    "mita.sisihome.org",
    "files.sisihome.org",
    "diary.sisihome.org",
    "key.sisihome.org",
    "opencode.sisihome.org",
    "provider-amd.sisihome.org",
    "provider-home.sisihome.org",
    "social.sisihome.org",
    "ching.sisihome.org",
    "hunter.sisihome.org",
    "frame.sisihome.org",
    "media.sisihome.org",
    "video.sisihome.org",
    "kevin.sisihome.org",
    "moonlight.sisihome.org",
    "skynet.sisihome.org"
)

if (-not $env:CF_API_TOKEN) {
    throw "CF_API_TOKEN is required. Use a Cloudflare token with Zone:DNS:Edit for sisihome.org."
}

$headers = @{
    Authorization = "Bearer $env:CF_API_TOKEN"
    "Content-Type" = "application/json"
}

$zoneResponse = Invoke-RestMethod -Method Get -Uri "$apiBase/zones?name=$zoneName" -Headers $headers
$zone = @($zoneResponse.result) | Select-Object -First 1
if (-not $zone.id) {
    throw "Cloudflare zone not found: $zoneName"
}

foreach ($recordName in $hostnames) {
    $recordsResponse = Invoke-RestMethod -Method Get -Uri "$apiBase/zones/$($zone.id)/dns_records?type=A&name=$recordName" -Headers $headers
    $records = @($recordsResponse.result)
    $targetRecord = $records | Where-Object { $_.content -eq $targetIp } | Select-Object -First 1

    $body = @{
        type = "A"
        name = $recordName
        content = $targetIp
        ttl = 60
        proxied = $false
        comment = "Private/Tailscale route to kevinhome desktop Caddy"
    } | ConvertTo-Json

    if (-not $targetRecord) {
        $result = Invoke-RestMethod -Method Post -Uri "$apiBase/zones/$($zone.id)/dns_records" -Headers $headers -Body $body
    } else {
        $result = Invoke-RestMethod -Method Put -Uri "$apiBase/zones/$($zone.id)/dns_records/$($targetRecord.id)" -Headers $headers -Body $body
    }

    if (-not $result.success) {
        throw "Cloudflare DNS update failed for ${recordName}: $($result.errors | ConvertTo-Json -Compress)"
    }

    Write-Host "$recordName -> $targetIp" -ForegroundColor Green
}

Write-Host "carsmeet.sisihome.org was not changed; it remains the public Cloudflare Tunnel exception." -ForegroundColor Cyan
Write-Host "Existing sibling A records were preserved for cross-account Tailscale access." -ForegroundColor Cyan
