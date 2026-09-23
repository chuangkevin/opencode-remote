# Rebuild opencode-remote on L390 (remote copy, not a git clone) and restart
# it via the watchdog scheduled task (detached from this ssh session, so
# disconnecting does not take the service down with it).
# The tarball was already unpacked over C:\Users\Kevin\opencode-remote,
# keeping the remote .env and node_modules.
param([string]$Commit = "")
$ErrorActionPreference = "Stop"
Set-Location C:\Users\Kevin\opencode-remote
if (Test-Path C:\Users\Kevin\opencode-remote-deploy\oc-remote.env.bak) {
    Copy-Item C:\Users\Kevin\opencode-remote-deploy\oc-remote.env.bak C:\Users\Kevin\opencode-remote\.env -Force
}
if ($Commit -ne "") {
    $env:OPENCODE_REMOTE_BUILD_COMMIT = $Commit
}
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Import-Module (Join-Path C:\Users\Kevin\opencode-remote "deploy\windows\opencode-remote-runtime.psm1") -Force
$paths = Get-OpenCodeRemotePaths C:\Users\Kevin\opencode-remote
$configuration = Get-OpenCodeRemoteConfiguration C:\Users\Kevin\opencode-remote
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
