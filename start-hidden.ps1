# One-click background start for opencode-remote.

param(
    [switch]$NoWatchdog,
    [switch]$Admin
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Admin -and -not (Test-IsAdministrator)) {
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "`"$PSCommandPath`"",
        "-Admin"
    )
    if ($NoWatchdog) {
        $arguments += "-NoWatchdog"
    }

    Start-Process -FilePath "powershell.exe" `
        -Verb RunAs `
        -WorkingDirectory $PSScriptRoot `
        -ArgumentList $arguments
    exit 0
}

Write-Host "Preparing opencode capability config..." -ForegroundColor Cyan
.\setup-capabilities.ps1 -SkipGithubToken -NonInteractive -Force -CopyFallback

Write-Host "Building opencode-remote..." -ForegroundColor Cyan
npm run build

if (-not $NoWatchdog) {
    Write-Host "Installing auto-restart watchdog..." -ForegroundColor Cyan
    .\install-watchdog.ps1
}

Write-Host "Starting opencode-remote in background..." -ForegroundColor Cyan

$process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start.ps1"), "-NoPrepare" `
    -WindowStyle Hidden `
    -PassThru

Write-Host "Started in background (PID: $($process.Id))" -ForegroundColor Green
Write-Host "  Service running on http://localhost:9223" -ForegroundColor Cyan
Write-Host "  External: https://opencode.sisihome.org" -ForegroundColor Cyan
