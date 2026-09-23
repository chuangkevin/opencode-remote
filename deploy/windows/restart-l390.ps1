# Restart and rebuild opencode-remote on L390 (remote copy, not a git clone).
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
& .\restart-service.ps1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
