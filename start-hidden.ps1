# One-click background start for opencode-remote.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Preparing opencode capability config..." -ForegroundColor Cyan
.\setup-capabilities.ps1 -SkipGithubToken -NonInteractive -Force -CopyFallback

Write-Host "Building opencode-remote..." -ForegroundColor Cyan
npm run build

Write-Host "Starting opencode-remote in background..." -ForegroundColor Cyan

$process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start.ps1"), "-NoPrepare" `
    -WindowStyle Hidden `
    -PassThru

Write-Host "Started in background (PID: $($process.Id))" -ForegroundColor Green
Write-Host "  Service running on http://localhost:9223" -ForegroundColor Cyan
Write-Host "  External: https://opencode.sisihome.org" -ForegroundColor Cyan
