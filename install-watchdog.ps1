# Install or update the opencode-remote auto-restart scheduled task.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$taskName = "opencode-remote-watchdog"
$scriptPath = Join-Path $PSScriptRoot "ensure-service.ps1"
$runnerPath = Join-Path $PSScriptRoot "run-watchdog-hidden.vbs"
$wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"

if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing watchdog script: $scriptPath"
}

if (-not (Test-Path -LiteralPath $runnerPath)) {
    throw "Missing hidden watchdog runner: $runnerPath"
}

$taskCommand = "`"$wscriptPath`" `"$runnerPath`""
& schtasks.exe /Create /TN $taskName /SC MINUTE /MO 5 /TR $taskCommand /F | Out-Null
& schtasks.exe /Run /TN $taskName | Out-Null

Write-Host "Installed watchdog scheduled task: $taskName" -ForegroundColor Green
Write-Host "It checks http://127.0.0.1:9223 and http://127.0.0.1:4096 every 5 minutes." -ForegroundColor Cyan
