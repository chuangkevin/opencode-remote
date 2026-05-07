# One-click foreground start for opencode-remote.

param(
    [switch]$NoPrepare
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Stop-PortProcess {
    param([int]$Port)

    $processIds = netstat -ano | Select-String ":$Port.*LISTENING" | ForEach-Object {
        ($_ -split "\s+")[-1]
    } | Select-Object -Unique

    foreach ($processId in $processIds) {
        if ($processId) {
            Write-Host "Stopping process on port $Port (PID $processId)..." -ForegroundColor Yellow
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
        }
    }
}

Stop-PortProcess 9223
Stop-PortProcess 4096
Start-Sleep -Seconds 1

if (-not $NoPrepare) {
    Write-Host "Preparing opencode capability config..." -ForegroundColor Cyan
    .\setup-capabilities.ps1 -SkipGithubToken -NonInteractive -Force -CopyFallback

    Write-Host "Building opencode-remote..." -ForegroundColor Cyan
    npm run build
}

Write-Host "Starting opencode-remote..." -ForegroundColor Cyan
npm start
