# Stop only the exact opencode-remote proxy and its direct OpenCode child.
param(
    [switch]$KeepWatchdog,
    [switch]$InternalSkipLifecycleLock
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Import-Module (Join-Path $PSScriptRoot "deploy\windows\opencode-remote-runtime.psm1") -Force
$paths = Get-OpenCodeRemotePaths $PSScriptRoot
$configuration = Get-OpenCodeRemoteConfiguration $PSScriptRoot
$lifecycleMutex = $null
try {
    if (-not $InternalSkipLifecycleLock) {
        $lifecycleMutex = Enter-OpenCodeRemoteMutex -Name Lifecycle -TimeoutMilliseconds 30000
        if (-not $lifecycleMutex) { throw "Timed out waiting for the service lifecycle lock." }
    }
    if (-not $KeepWatchdog) {
        Disable-ScheduledTask -TaskName "opencode-remote-watchdog" -ErrorAction SilentlyContinue | Out-Null
    }
    Stop-OwnedOpenCodeRemote $paths $configuration
    Write-Host "OpenCode Remote owned service stopped." -ForegroundColor Green
} finally {
    Exit-OpenCodeRemoteMutex $lifecycleMutex
}
