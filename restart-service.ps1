# Restart only the exact opencode-remote service and wait for bounded recovery.
param([switch]$InternalSkipLifecycleLock)

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
    Stop-OwnedOpenCodeRemote $paths $configuration
    $probeFile = Ensure-OpenCodeRemoteProbe $configuration
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start.ps1"),
        "-NoPrepare", "-InternalSkipLifecycleLock"
    ) -WindowStyle Hidden -PassThru
    if (-not (Wait-OpenCodeRemoteRuntime $configuration "" $probeFile)) {
        throw "OpenCode Remote did not recover on configured ports; starter PID $($process.Id)."
    }
    Write-Host "OpenCode Remote restarted and verified." -ForegroundColor Green
} finally {
    Exit-OpenCodeRemoteMutex $lifecycleMutex
}
