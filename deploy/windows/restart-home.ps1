# Restart and rebuild opencode-remote on kevinhome (git clone).
$ErrorActionPreference = "Stop"
Set-Location D:\GitClone\_HomeProject\opencode-remote
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& .\restart-service.ps1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
