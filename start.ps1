# One-click foreground start for opencode-remote.
param(
    [switch]$NoPrepare,
    [switch]$InternalSkipLifecycleLock
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
Import-Module (Join-Path $PSScriptRoot "deploy\windows\opencode-remote-runtime.psm1") -Force
$paths = Get-OpenCodeRemotePaths $PSScriptRoot
$configuration = Get-OpenCodeRemoteConfiguration $PSScriptRoot
$lifecycleMutex = $null
$runtimeProcess = $null

try {
    if (-not $InternalSkipLifecycleLock) {
        $lifecycleMutex = Enter-OpenCodeRemoteMutex -Name Lifecycle -TimeoutMilliseconds 30000
        if (-not $lifecycleMutex) { throw "Timed out waiting for the service lifecycle lock." }
    }
    Stop-OwnedOpenCodeRemote $paths $configuration
    if (-not $NoPrepare) {
        Write-Host "Preparing opencode capability config..." -ForegroundColor Cyan
        .\setup-capabilities.ps1 -SkipGithubToken -NonInteractive -Force -CopyFallback
        Write-Host "Building opencode-remote..." -ForegroundColor Cyan
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed; refusing to start stale dist output." }
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $env:PORT = [string]$configuration.RemotePort
    $env:OPENCODE_PORT = [string]$configuration.OpenCodePort
    # OpenCode 1.18.30 的 /file/content 在工作目錄是反斜線形式時一律回 400，
    # 正斜線形式則正常。Get-OpenCodeRemoteConfiguration 用 [IO.Path]::GetFullPath()
    # 會產生反斜線，而 node 的 --env-file 不會覆蓋已存在的環境變數，
    # 所以這個值會蓋掉 .env 裡正確的正斜線設定，健康探針就永遠過不了。
    $env:OPENCODE_DIRECTORY = $configuration.Workspace -replace '\\', '/'
    $env:OPENCODE_UPDATE_QUIESCE_FILE = $paths.QuiesceFile
    $probeFile = Ensure-OpenCodeRemoteProbe $configuration
    Write-Host "Starting opencode-remote on configured ports $($configuration.RemotePort)/$($configuration.OpenCodePort)..." -ForegroundColor Cyan

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $node
    $quotedEnv = '"' + ($paths.EnvFile -replace '"', '\"') + '"'
    $quotedEntry = '"' + ($paths.ServerEntry -replace '"', '\"') + '"'
    $startInfo.Arguments = "--env-file=$quotedEnv $quotedEntry"
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $runtimeProcess = New-Object Diagnostics.Process
    $runtimeProcess.StartInfo = $startInfo
    if (-not $runtimeProcess.Start()) { throw "Failed to start the Node runtime." }
    if (-not (Wait-OpenCodeRemoteRuntime $configuration "" $probeFile)) {
        if (-not $runtimeProcess.HasExited) { $runtimeProcess.Kill() }
        throw "OpenCode Remote did not pass bounded health and workspace probe checks."
    }
} finally {
    Exit-OpenCodeRemoteMutex $lifecycleMutex
}

$runtimeProcess.WaitForExit()
exit $runtimeProcess.ExitCode
