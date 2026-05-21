# One-click foreground start for opencode-remote.

param(
    [switch]$NoPrepare
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Stop-PortProcess {
    param([int]$Port)

    # Two-layer defense to stop us from killing the wrong process:
    #   1. Numeric port match via Get-NetTCPConnection (the previous
    #      substring `netstat | Select-String ":$Port.*LISTENING"` matched
    #      40961, 14096, 92230 etc.).
    #   2. Process-name allowlist — even if a process LEGITIMATELY owns
    #      our target port (e.g. a Docker container publishing 4096 via
    #      vpnkit), we must not kill it. That happened: the repo's own
    #      docker-compose.yml publishes 4096, vpnkit binds 4096 on host,
    #      and Stop-PortProcess murdered vpnkit → Docker stack collapsed.
    $candidates = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object { $_.OwningProcess } |
        Select-Object -Unique

    foreach ($processId in $candidates) {
        if (-not $processId) { continue }
        $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }

        $name = $proc.ProcessName
        # Allowlist: our proxy (node) and the OpenCode CLI. Anything else
        # owns the port for a legit reason — leave it alone.
        $isOurs = $name -ieq "node" -or $name -ieq "opencode-cli" -or $name -ieq "opencode"
        if (-not $isOurs) {
            Write-Host "Port $Port is held by '$name' (PID $processId); skipping — not an opencode process." -ForegroundColor Yellow
            continue
        }

        Write-Host "Stopping $name on port $Port (PID $processId)..." -ForegroundColor Yellow
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
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
