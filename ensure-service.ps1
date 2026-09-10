# Health check and bounded self-heal entrypoint for Windows Task Scheduler.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Import-Module (Join-Path $PSScriptRoot "deploy\windows\opencode-remote-runtime.psm1") -Force
$paths = Get-OpenCodeRemotePaths $PSScriptRoot
$configuration = Get-OpenCodeRemoteConfiguration $PSScriptRoot
[IO.Directory]::CreateDirectory($paths.LogRoot) | Out-Null
$logPath = Join-Path $paths.LogRoot "opencode-remote-watchdog.log"

function Write-WatchdogLog([string]$Message) {
    Add-Content -LiteralPath $logPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $Message"
}

$lifecycleMutex = Enter-OpenCodeRemoteMutex -Name Lifecycle -TimeoutMilliseconds 0
if (-not $lifecycleMutex) { exit 0 }
try {
    $probeFile = Ensure-OpenCodeRemoteProbe $configuration
    if (Test-OpenCodeRemoteRuntime $configuration "" $probeFile) { exit 0 }
    Write-WatchdogLog "Service unhealthy; starting bounded recovery on configured ports."
    & (Join-Path $PSScriptRoot "restart-service.ps1") -InternalSkipLifecycleLock
    if (-not (Test-OpenCodeRemoteRuntime $configuration "" $probeFile)) { throw "Recovery returned without verified health." }
    Write-WatchdogLog "Service recovery verified."
} catch {
    Write-WatchdogLog "Watchdog failed: $($_.Exception.Message)"
    exit 1
} finally {
    Exit-OpenCodeRemoteMutex $lifecycleMutex
}
