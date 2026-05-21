# One-click foreground start for opencode-remote.

param(
    [switch]$NoPrepare
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Stop-PortProcess {
    param([int]$Port)

    # Use Get-NetTCPConnection so the port match is NUMERIC, not substring.
    # The old `netstat -ano | Select-String ":$Port.*LISTENING"` was a
    # substring match that accidentally killed processes on ports like
    # 40961, 14096, 92230, 49612 — Docker Desktop's vpnkit / backend pick
    # high ephemeral ports that often contain "4096" or "9223" as a
    # substring, and the watchdog's 5-minute restart was nuking them,
    # crashing Docker (verified — every Docker crash timestamp lined up
    # with a watchdog "Service unhealthy; restarting" log entry).
    $processIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { $_.OwningProcess } |
        Select-Object -Unique

    foreach ($processId in $processIds) {
        if ($processId) {
            Write-Host "Stopping process on port $Port (PID $processId)..." -ForegroundColor Yellow
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-EnvValue {
    param(
        [string]$Name,
        [string]$Fallback
    )

    $envPath = Join-Path $PSScriptRoot ".env"
    if (Test-Path -LiteralPath $envPath) {
        $line = Get-Content -LiteralPath $envPath | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -First 1
        if ($line) {
            return ($line -replace "^$([regex]::Escape($Name))=", "").Trim()
        }
    }

    return $Fallback
}

function Test-PortListening {
    param([int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $listener
}

function Get-AvailablePort {
    param([int]$StartPort)

    $port = $StartPort
    while (Test-PortListening $port) {
        $port++
    }
    return $port
}

function Get-CurrentOpenCodePort {
    param([int]$RemotePort)

    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$RemotePort/remote-health" -TimeoutSec 2
        if ($health.upstream -match ':(\d+)$') {
            return [int]$Matches[1]
        }
    } catch {
        return $null
    }

    return $null
}

$remotePort = [int](Get-EnvValue "PORT" "9223")
$opencodePort = [int](Get-EnvValue "OPENCODE_PORT" "4096")
$currentOpenCodePort = Get-CurrentOpenCodePort $remotePort

if ($null -ne $currentOpenCodePort -and $currentOpenCodePort -ne $opencodePort) {
    Stop-PortProcess $currentOpenCodePort
}

Stop-PortProcess $remotePort
Stop-PortProcess $opencodePort
Start-Sleep -Seconds 1

if (Test-PortListening $opencodePort) {
    $fallbackPort = Get-AvailablePort ($opencodePort + 1)
    Write-Host "OpenCode port $opencodePort is still unavailable; using $fallbackPort for this start." -ForegroundColor Yellow
    $env:OPENCODE_PORT = [string]$fallbackPort
}

if (-not $NoPrepare) {
    Write-Host "Preparing opencode capability config..." -ForegroundColor Cyan
    .\setup-capabilities.ps1 -SkipGithubToken -NonInteractive -Force -CopyFallback

    Write-Host "Building opencode-remote..." -ForegroundColor Cyan
    npm run build
}

Write-Host "Starting opencode-remote..." -ForegroundColor Cyan
npm start
