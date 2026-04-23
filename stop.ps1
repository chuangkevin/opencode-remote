# Stop opencode-remote service

Write-Host "Stopping opencode-remote..." -ForegroundColor Cyan

# Find and kill process on port 9223
$proxy = netstat -ano | Select-String ":9223.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1

if ($proxy) {
    Write-Host "  Stopping proxy (PID $proxy)..." -ForegroundColor Yellow
    Stop-Process -Id $proxy -Force -ErrorAction SilentlyContinue
    Write-Host "✓ Proxy stopped" -ForegroundColor Green
} else {
    Write-Host "  No proxy running on port 9223" -ForegroundColor Gray
}

# Find and kill OpenCode on port 4096
$opencode = netstat -ano | Select-String ":4096.*LISTENING" | ForEach-Object {
    ($_ -split "\s+")[-1]
} | Select-Object -First 1

if ($opencode) {
    Write-Host "  Stopping OpenCode (PID $opencode)..." -ForegroundColor Yellow
    Stop-Process -Id $opencode -Force -ErrorAction SilentlyContinue
    Write-Host "✓ OpenCode stopped" -ForegroundColor Green
} else {
    Write-Host "  No OpenCode running on port 4096" -ForegroundColor Gray
}

Write-Host ""
Write-Host "✓ All services stopped" -ForegroundColor Green
