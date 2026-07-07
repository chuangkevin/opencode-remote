# Ensure opencode.sisihome.org has Kevin's kevinhome Tailscale A record.
# Do not delete other A records: sisihome.org intentionally keeps dual A
# records for devices shared into another Tailscale account.

$ErrorActionPreference = "Stop"

$zoneName = "sisihome.org"
$recordName = "opencode.sisihome.org"
$targetIp = "100.83.112.20"
$apiBase = "https://api.cloudflare.com/client/v4"

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

$recordsResponse = Invoke-RestMethod -Method Get -Uri "$apiBase/zones/$($zone.id)/dns_records?type=A&name=$recordName" -Headers $headers
$records = @($recordsResponse.result)
$targetRecord = $records | Where-Object { $_.content -eq $targetIp } | Select-Object -First 1

$body = @{
    type = "A"
    name = $recordName
    content = $targetIp
    ttl = 60
    proxied = $false
    comment = "Temporary private/Tailscale route to kevinhome opencode-remote"
} | ConvertTo-Json

if (-not $targetRecord) {
    $result = Invoke-RestMethod -Method Post -Uri "$apiBase/zones/$($zone.id)/dns_records" -Headers $headers -Body $body
} else {
    $result = Invoke-RestMethod -Method Put -Uri "$apiBase/zones/$($zone.id)/dns_records/$($targetRecord.id)" -Headers $headers -Body $body
}

if (-not $result.success) {
    throw "Cloudflare DNS update failed: $($result.errors | ConvertTo-Json -Compress)"
}

Write-Host "$recordName -> $targetIp" -ForegroundColor Green
Write-Host "Existing sibling A records were preserved for cross-account Tailscale access." -ForegroundColor Cyan
