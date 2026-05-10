# Health check and self-heal entrypoint for Windows Task Scheduler.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$logPath = Join-Path $PSScriptRoot "opencode-remote-watchdog.log"
$mutex = New-Object System.Threading.Mutex($false, "opencode-remote-watchdog")

function Write-WatchdogLog {
    param([string]$Message)

    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $logPath -Value "[$timestamp] $Message"
}

function Test-OpenCodeHealth {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4096/global/health" -TimeoutSec 5
        $json = $response.Content | ConvertFrom-Json
        return ($response.StatusCode -eq 200 -and $json.healthy -eq $true)
    } catch {
        return $false
    }
}

function Test-ProxyHealth {
    try {
        $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:9223/")
        $request.AllowAutoRedirect = $false
        $request.Timeout = 5000
        $request.Method = "GET"
        $response = $request.GetResponse()
        try {
            $statusCode = [int]$response.StatusCode
            return ($statusCode -eq 200 -or $statusCode -eq 302)
        } finally {
            $response.Close()
        }
    } catch {
        return $false
    }
}

$hasLock = $false

try {
    $hasLock = $mutex.WaitOne(0)
    if (-not $hasLock) {
        exit 0
    }

    if ((Test-OpenCodeHealth) -and (Test-ProxyHealth)) {
        exit 0
    }

    Write-WatchdogLog "Service unhealthy; restarting opencode-remote."
    $process = Start-Process -FilePath "powershell.exe" `
        -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $PSScriptRoot "start.ps1"), "-NoPrepare" `
        -WindowStyle Hidden `
        -PassThru
    Write-WatchdogLog "Started restart process PID $($process.Id)."
} catch {
    Write-WatchdogLog "Watchdog failed: $($_.Exception.Message)"
    exit 1
} finally {
    if ($hasLock) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
