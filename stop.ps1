# Stop opencode-remote service

param(
    [switch]$KeepWatchdog
)

Write-Host "Stopping opencode-remote..." -ForegroundColor Cyan

if (-not $KeepWatchdog) {
    $task = & schtasks.exe /Query /TN "opencode-remote-watchdog" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  Disabling watchdog scheduled task..." -ForegroundColor Yellow
        & schtasks.exe /Change /TN "opencode-remote-watchdog" /DISABLE | Out-Null
        Write-Host "✓ Watchdog disabled" -ForegroundColor Green
    }
}

# Use Get-NetTCPConnection (NUMERIC port match) rather than
# `netstat | Select-String ":<port>.*LISTENING"`. The substring match in
# the old code was killing Docker Desktop processes whose ephemeral ports
# happened to contain "4096" or "9223" as a substring (e.g. 40961, 14096,
# 92230). See start.ps1 for the same fix in Stop-PortProcess.
function Stop-PortProcessExact {
    param(
        [int]$Port,
        [string]$Label
    )

    $processIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { $_.OwningProcess } |
        Select-Object -Unique

    if (-not $processIds) {
        Write-Host "  No $Label running on port $Port" -ForegroundColor Gray
        return
    }

    foreach ($processId in $processIds) {
        Write-Host "  Stopping $Label (PID $processId)..." -ForegroundColor Yellow
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
    Write-Host "✓ $Label stopped" -ForegroundColor Green
}

Stop-PortProcessExact -Port 9223 -Label "proxy"
Stop-PortProcessExact -Port 4096 -Label "OpenCode"

Write-Host ""
Write-Host "✓ All services stopped" -ForegroundColor Green
