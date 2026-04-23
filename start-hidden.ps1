# Start opencode-remote in background without window

# Kill any existing process on port 9223
$existing = netstat -ano | Select-String ":9223.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1

if ($existing) {
    Write-Host "Stopping existing process (PID $existing)..." -ForegroundColor Yellow
    Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# Start in hidden window
Write-Host "Starting opencode-remote in background..." -ForegroundColor Cyan
Set-Location $PSScriptRoot

$process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$PSScriptRoot'; npm start" `
    -WindowStyle Hidden `
    -PassThru

Write-Host "✓ Started in background (PID: $($process.Id))" -ForegroundColor Green
Write-Host "  Service running on http://localhost:9223" -ForegroundColor Cyan
Write-Host "  External: https://opencode.sisihome.org" -ForegroundColor Cyan
Write-Host ""
Write-Host "To stop: taskkill /F /PID $($process.Id)" -ForegroundColor Yellow
