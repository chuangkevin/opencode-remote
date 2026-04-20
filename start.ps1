# Kill any existing process on port 9223
$existing = netstat -ano | Select-String ":9223.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1

if ($existing) {
    Write-Host "Stopping existing process (PID $existing)..." -ForegroundColor Yellow
    Stop-Process -Id $existing -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}

# Start the proxy
Write-Host "Starting opencode-remote..." -ForegroundColor Cyan
Set-Location $PSScriptRoot
npm start
