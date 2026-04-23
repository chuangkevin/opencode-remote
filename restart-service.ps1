# Restart opencode-remote service

Write-Host "Stopping all OpenCode and Node processes..." -ForegroundColor Yellow

# Kill all OpenCode processes
Get-Process -Name "opencode*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name "OpenCode*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Kill node processes running opencode-remote
Get-Process | Where-Object { $_.Path -like "*opencode-remote*" } | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2

Write-Host "Starting opencode-remote..." -ForegroundColor Cyan

# Set location and start
Set-Location "D:\GitClone\_HomeProject\opencode-remote"
npm start
