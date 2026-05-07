# Restart opencode-remote service.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Stopping all OpenCode and opencode-remote processes..." -ForegroundColor Yellow
Get-Process -Name "opencode*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "OpenCode*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process | Where-Object { $_.Path -like "*opencode-remote*" } | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2

& (Join-Path $PSScriptRoot "start.ps1")
