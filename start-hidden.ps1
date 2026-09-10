# One-click verified background start for opencode-remote.
param([switch]$NoWatchdog, [switch]$Admin)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if ($Admin -and -not (Test-IsAdministrator)) {
    $arguments = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-Admin")
    if ($NoWatchdog) { $arguments += "-NoWatchdog" }
    Start-Process -FilePath "powershell.exe" -Verb RunAs -WorkingDirectory $PSScriptRoot -ArgumentList $arguments
    exit 0
}

Write-Host "Preparing opencode capability config..." -ForegroundColor Cyan
.\setup-capabilities.ps1 -SkipGithubToken -NonInteractive -Force -CopyFallback
Write-Host "Building opencode-remote..." -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed; refusing to start stale dist output." }

Import-Module (Join-Path $PSScriptRoot "deploy\windows\opencode-remote-runtime.psm1") -Force
$configuration = Get-OpenCodeRemoteConfiguration $PSScriptRoot
$probeFile = Ensure-OpenCodeRemoteProbe $configuration
$cli = Resolve-OpenCodeCli $PSScriptRoot
$versionOutput = @(& $cli --version)
if ($LASTEXITCODE -ne 0 -or $versionOutput.Count -ne 1) { throw "Current OpenCode CLI version is unavailable." }
$version = ([string]$versionOutput[0]).Trim()

$process = Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start.ps1"), "-NoPrepare"
) -WindowStyle Hidden -PassThru
if (-not (Wait-OpenCodeRemoteRuntime $configuration $version $probeFile)) {
    throw "Background service PID $($process.Id) did not pass exact version and workspace probe checks."
}

if (-not $NoWatchdog) {
    Write-Host "Installing auto-restart watchdog..." -ForegroundColor Cyan
    .\install-watchdog.ps1
}
Write-Host "Installing idle-only updater after service verification..." -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "deploy\windows\install-opencode-updater.ps1")
Write-Host "Service verified on http://localhost:$($configuration.RemotePort) (starter PID: $($process.Id))." -ForegroundColor Green
