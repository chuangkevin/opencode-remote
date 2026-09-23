# Rebuild opencode-remote on kevinhome (git clone) and restart it via the
# watchdog scheduled task (detached from this ssh session).
$ErrorActionPreference = "Stop"
Set-Location D:\GitClone\_HomeProject\opencode-remote
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Import-Module (Join-Path D:\GitClone\_HomeProject\opencode-remote "deploy\windows\opencode-remote-runtime.psm1") -Force
$paths = Get-OpenCodeRemotePaths D:\GitClone\_HomeProject\opencode-remote
$configuration = Get-OpenCodeRemoteConfiguration D:\GitClone\_HomeProject\opencode-remote
Stop-OwnedOpenCodeRemote $paths $configuration
Start-ScheduledTask -TaskName opencode-remote-watchdog
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    $listening = Get-NetTCPConnection -LocalPort $configuration.RemotePort -State Listen -ErrorAction SilentlyContinue
    if ($listening) { exit 0 }
    Start-Sleep -Seconds 2
}
Write-Host "Service did not start listening within 60 seconds." -ForegroundColor Red
exit 1
