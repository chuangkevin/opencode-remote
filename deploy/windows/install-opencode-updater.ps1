$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Import-Module (Join-Path $PSScriptRoot "opencode-remote-runtime.psm1") -Force
$paths = Get-OpenCodeRemotePaths $repoRoot
$configuration = Get-OpenCodeRemoteConfiguration $repoRoot
$probeFile = Ensure-OpenCodeRemoteProbe $configuration
$currentCli = Resolve-OpenCodeCli $repoRoot
$versionOutput = @(& $currentCli --version)
if ($LASTEXITCODE -ne 0 -or $versionOutput.Count -ne 1) { throw "Current OpenCode CLI version is unavailable." }
$currentVersion = ([string]$versionOutput[0]).Trim()
if ($currentVersion -notmatch '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$') { throw "Current OpenCode CLI version is unavailable." }
$taskName = "opencode-remote-updater"

$lifecycleMutex = Enter-OpenCodeRemoteMutex -Name Lifecycle -TimeoutMilliseconds 30000
if (-not $lifecycleMutex) { throw "Timed out waiting for the service lifecycle lock." }
try {
    if (-not (Test-OpenCodeRemoteRuntime $configuration $currentVersion $probeFile)) { throw "Current service must pass exact health/version and workspace probe before updater installation." }

    [IO.Directory]::CreateDirectory($paths.RuntimeRoot) | Out-Null
    [IO.Directory]::CreateDirectory($paths.LogRoot) | Out-Null
    [IO.Directory]::CreateDirectory($paths.VersionsRoot) | Out-Null
    Set-OpenCodeRemotePrivateAcl $paths.RuntimeRoot
    Set-OpenCodeRemotePrivateAcl $paths.CliRoot
    Set-OpenCodeRemotePrivateAcl $paths.VersionsRoot
    if (Test-Path -LiteralPath $paths.DesktopState -PathType Leaf) { Set-OpenCodeRemotePrivateAcl $paths.DesktopState }

    $pluginDirectory = Join-Path $env:USERPROFILE ".config\opencode\plugins"
    $libraryDirectory = Join-Path $env:USERPROFILE ".config\opencode\opencode-remote"
    [IO.Directory]::CreateDirectory($pluginDirectory) | Out-Null
    [IO.Directory]::CreateDirectory($libraryDirectory) | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "opencode-remote-desktop-bridge.js") -Destination (Join-Path $pluginDirectory "opencode-remote-desktop-bridge.js") -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot "deploy\opencode-remote\opencode-remote-desktop-bridge-lib.js") -Destination (Join-Path $libraryDirectory "opencode-remote-desktop-bridge-lib.js") -Force
    Copy-Item -LiteralPath (Join-Path $repoRoot "deploy\opencode-remote\package.json") -Destination (Join-Path $libraryDirectory "package.json") -Force
    Set-OpenCodeRemotePrivateAcl $libraryDirectory

    Remove-Item -LiteralPath $paths.BlockFile -Force -ErrorAction SilentlyContinue
    $runner = Join-Path $PSScriptRoot "run-opencode-updater-hidden.vbs"
    $wscript = Join-Path $env:WINDIR "System32\wscript.exe"
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $user = $identity.Name
    $userSid = [Security.SecurityElement]::Escape($identity.User.Value)
    $escapedWscript = [Security.SecurityElement]::Escape($wscript)
    $escapedRunner = [Security.SecurityElement]::Escape('"' + $runner + '"')
    $startBoundary = (Get-Date).AddMinutes(1).ToString("yyyy-MM-ddTHH:mm:ss")
    $taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$userSid</UserId></LogonTrigger>
    <TimeTrigger>
      <Repetition><Interval>PT1H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>$startBoundary</StartBoundary><Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$userSid</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable>
    <Hidden>true</Hidden><ExecutionTimeLimit>PT20M</ExecutionTimeLimit><Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>$escapedWscript</Command><Arguments>$escapedRunner</Arguments></Exec></Actions>
</Task>
"@
    Register-ScheduledTask -TaskName $taskName -Xml $taskXml -Force | Out-Null
} finally {
    Exit-OpenCodeRemoteMutex $lifecycleMutex
}
Start-ScheduledTask -TaskName $taskName
Write-Host "Installed $taskName for $user and started an immediate update check. Restart OpenCode Desktop once to activate the bridge on first install." -ForegroundColor Green
