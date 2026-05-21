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

# Numeric port match (Get-NetTCPConnection) + process-name allowlist.
# Earlier substring-style `netstat | Select-String ":<port>.*LISTENING"`
# wrecked Docker by killing vpnkit when ports overlapped (e.g. Docker
# Desktop ephemeral 40961 / 14096; the docker-compose.yml in this repo
# publishing 4096). The allowlist is the second layer: even if a legit
# non-opencode process owns the port, we must not kill it.
function Stop-PortProcessExact {
    param(
        [int]$Port,
        [string]$Label
    )

    $candidates = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { $_.OwningProcess } |
        Select-Object -Unique

    if (-not $candidates) {
        Write-Host "  No $Label running on port $Port" -ForegroundColor Gray
        return
    }

    $killed = $false
    foreach ($processId in $candidates) {
        $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        $name = $proc.ProcessName
        $isOurs = $name -ieq "node" -or $name -ieq "opencode-cli" -or $name -ieq "opencode"
        if (-not $isOurs) {
            Write-Host "  Port $Port held by '$name' (PID $processId); skipping — not an opencode process." -ForegroundColor Yellow
            continue
        }
        Write-Host "  Stopping $Label '$name' (PID $processId)..." -ForegroundColor Yellow
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        $killed = $true
    }
    if ($killed) { Write-Host "✓ $Label stopped" -ForegroundColor Green }
}

# Read OPENCODE_PORT from .env so this stays in sync if the user changes it.
function Get-EnvValue {
    param([string]$Name, [string]$Fallback)
    $envPath = Join-Path $PSScriptRoot ".env"
    if (Test-Path -LiteralPath $envPath) {
        $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -First 1
        if ($line) { return ($line -replace "^$([regex]::Escape($Name))=", "").Trim() }
    }
    return $Fallback
}

$opencodePort = [int](Get-EnvValue "OPENCODE_PORT" "4096")
Stop-PortProcessExact -Port 9223 -Label "proxy"
Stop-PortProcessExact -Port $opencodePort -Label "OpenCode"

Write-Host ""
Write-Host "✓ All services stopped" -ForegroundColor Green
