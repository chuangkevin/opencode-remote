param([switch]$Scheduled)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Import-Module (Join-Path $PSScriptRoot "opencode-remote-runtime.psm1") -Force
$paths = Get-OpenCodeRemotePaths $repoRoot
$configuration = Get-OpenCodeRemoteConfiguration $repoRoot
$logPath = Join-Path $paths.LogRoot "opencode-remote-updater.log"
$npm = Get-CommandExecutablePath "npm.cmd"
$node = Get-CommandExecutablePath "node.exe"
$semverHelper = Join-Path $PSScriptRoot "exact-semver.js"
$maintenanceUrl = "http://10.11.12.55:3001/api/maintenance"
$updaterMutex = $null
$lifecycleMutex = $null
$transactionToken = $null
$currentJournal = $null
$stageDirectory = $null
$stageCleanupSafe = $true
$pointerSwitched = $false
$updateVerified = $false
$serviceMutationStarted = $false
$oldVersion = $null
$probeFile = $null
$maintenanceId = $null
$leaveMaintenance = $false

function Write-UpdateLog([string]$Message) {
    try {
        [IO.Directory]::CreateDirectory($paths.LogRoot) | Out-Null
        $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK') $Message"
        Add-Content -LiteralPath $logPath -Value $line -ErrorAction Stop
        if (-not $Scheduled) { Write-Host $line }
    } catch { }
}

function Get-ExactCliVersion([string]$Executable) {
    $output = @(& $Executable --version 2>$null)
    if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1) { throw "CLI version command failed." }
    $version = ([string]$output[0]).Trim()
    if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$') { throw "CLI returned a non-exact version." }
    return $version
}

function Quote-ProcessArgument([string]$Value) {
    if ($Value -notmatch '[\s"]') { return $Value }
    return '"' + ($Value -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

function Get-ExactProcessTreeIds([int]$RootProcessId) {
    $records = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $ids = [Collections.Generic.HashSet[int]]::new()
    $null = $ids.Add($RootProcessId)
    do {
        $added = $false
        foreach ($record in $records) {
            if ($ids.Contains([int]$record.ParentProcessId) -and $ids.Add([int]$record.ProcessId)) { $added = $true }
        }
    } while ($added)
    return @($ids)
}

function Invoke-BoundedProcess([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds) {
    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = (($Arguments | ForEach-Object { Quote-ProcessArgument $_ }) -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) { throw "Failed to start bounded command." }
    $outTask = $process.StandardOutput.ReadToEndAsync()
    $errTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        $treeProcessIds = @($process.Id)
        try { $treeProcessIds = @(Get-ExactProcessTreeIds $process.Id) } catch { }
        $terminationFailure = $null
        try {
            $taskkill = Get-CommandExecutablePath "taskkill.exe"
            $terminationInfo = New-Object Diagnostics.ProcessStartInfo
            $terminationInfo.FileName = $taskkill
            $terminationInfo.Arguments = "/PID $($process.Id) /T /F"
            $terminationInfo.UseShellExecute = $false
            $terminationInfo.CreateNoWindow = $true
            $termination = New-Object Diagnostics.Process
            $termination.StartInfo = $terminationInfo
            if (-not $termination.Start()) { throw "Failed to start exact process-tree termination." }
            if (-not $termination.WaitForExit(30000)) {
                try { $termination.Kill() } catch { }
                $terminationFailure = "taskkill did not exit within 30 seconds"
            } elseif ($termination.ExitCode -ne 0) {
                $terminationFailure = "taskkill exited with code $($termination.ExitCode)"
            }
        } catch {
            $terminationFailure = $_.Exception.Message
        }
        if (-not $process.WaitForExit(30000)) {
            $script:stageCleanupSafe = $false
            throw "Timed-out process tree did not terminate within 30 seconds."
        }
        $descendantDeadline = [DateTime]::UtcNow.AddSeconds(30)
        foreach ($processId in $treeProcessIds) {
            while (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
                if ([DateTime]::UtcNow -ge $descendantDeadline) {
                    $script:stageCleanupSafe = $false
                    throw "Timed-out process descendants did not terminate within 30 seconds."
                }
                Start-Sleep -Milliseconds 100
            }
        }
        $outTask.Wait(); $errTask.Wait()
        if ($terminationFailure) { throw "Timed-out process tree termination failed safely after process exit: $terminationFailure" }
        throw "Bounded command timed out after $TimeoutSeconds seconds; exact PID tree terminated."
    }
    $outTask.Wait(); $errTask.Wait()
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Stdout = $outTask.Result; Stderr = $errTask.Result }
}

function Test-CurrentUserOwnedRegularFile([string]$Path) {
    try {
        $item = Get-Item -LiteralPath $Path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
        $owner = (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier])
        return $owner -eq [Security.Principal.WindowsIdentity]::GetCurrent().User
    } catch { return $false }
}

function Read-TransactionJson([string]$Path) {
    if (-not (Test-CurrentUserOwnedRegularFile $Path)) { throw "Transaction state is missing, reparse-backed, or not owned by the current user." }
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Length -gt 65536) { throw "Transaction state is too large." }
    $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ($null -eq $value -or $value -is [Array] -or $value -isnot [pscustomobject]) { throw "Transaction state is malformed." }
    return $value
}

function Read-UpdateMarker([string]$Path) {
    $marker = Read-TransactionJson $Path
    if ((@($marker.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'createdAt,pid,token' -or
        $marker.pid -isnot [int] -or $marker.pid -le 0 -or
        $marker.token -isnot [string] -or $marker.token -notmatch '^[0-9a-f]{32}$' -or
        $marker.createdAt -isnot [long] -or $marker.createdAt -le 0) { throw "Update quiesce marker is malformed." }
    return $marker
}

function Read-UpdateJournal {
    $journal = Read-TransactionJson $paths.JournalFile
    if ((@($journal.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'newVersion,oldVersion,pid,priorPointerContent,priorPointerExisted,schemaVersion,token' -or
        $journal.schemaVersion -ne 1 -or $journal.pid -isnot [int] -or $journal.pid -le 0 -or
        $journal.token -isnot [string] -or $journal.token -notmatch '^[0-9a-f]{32}$' -or
        $journal.oldVersion -isnot [string] -or $journal.oldVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' -or
        $journal.newVersion -isnot [string] -or $journal.newVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' -or
        $journal.priorPointerExisted -isnot [bool] -or
        ($journal.priorPointerExisted -and $journal.priorPointerContent -isnot [string]) -or
        (-not $journal.priorPointerExisted -and $null -ne $journal.priorPointerContent)) { throw "Update transaction journal is malformed." }
    $null = Get-UpdateDecision ([string]$journal.oldVersion) ([string]$journal.newVersion) $true
    return $journal
}

function Remove-OwnedTransactionFile([string]$Path, [string]$Token) {
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    try {
        $value = Read-TransactionJson $Path
        if ($value.token -isnot [string] -or $value.token -cne $Token) { return $false }
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
        return -not (Test-Path -LiteralPath $Path)
    } catch { return $false }
}

function Complete-TransactionFiles([string]$Token) {
    if (-not (Remove-OwnedTransactionFile $paths.QuiesceFile $Token)) { throw "Refused to remove a quiesce marker owned by another transaction." }
    if (-not (Remove-OwnedTransactionFile $paths.JournalFile $Token)) { throw "Refused to remove a journal owned by another transaction." }
}

function Clear-StaleOrphanedQuiesce {
    if (-not (Test-Path -LiteralPath $paths.QuiesceFile)) { return }
    $marker = Read-UpdateMarker $paths.QuiesceFile
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $minimumAge = [long](New-TimeSpan -Minutes 25).TotalMilliseconds
    if ($marker.createdAt -gt ($now + 60000) -or ($now - $marker.createdAt) -lt $minimumAge) {
        throw "Existing update quiesce marker is not safely reclaimable."
    }
    if (-not (Remove-OwnedTransactionFile $paths.QuiesceFile $marker.token)) { throw "Stale update quiesce marker could not be reclaimed." }
    Write-UpdateLog "RECOVERED stale orphaned quiesce marker."
}

function Test-DesktopRunning {
    $owned = Get-OwnedServiceProcesses $paths $configuration
    $ownedChild = if ($owned.ChildPid) { [int]$owned.ChildPid } else { -1 }
    return $null -ne (Get-CimInstance Win32_Process -Filter "Name = 'OpenCode.exe' OR Name = 'opencode.exe'" -ErrorAction SilentlyContinue |
        Where-Object { [int]$_.ProcessId -ne $ownedChild -and $_.CommandLine -notmatch 'serve\s+--hostname\s+127\.0\.0\.1' } |
        Select-Object -First 1)
}

function Test-StrictIdle {
    try {
        $directory = [Uri]::EscapeDataString($configuration.Workspace)
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$($configuration.RemotePort)/c/session-status?strict=1&directory=$directory" -TimeoutSec 5
        if ($response.StatusCode -ne 200) { return [pscustomobject]@{ Idle = $false; Reason = "strict status HTTP failure" } }
        $sources = @(([string]$response.Headers["X-OpenCode-Status-Sources"]).Split(',') | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ })
        if ($sources -notcontains "remote") { return [pscustomobject]@{ Idle = $false; Reason = "remote status source missing" } }
        if ((Test-DesktopRunning) -and $sources -notcontains "desktop") { return [pscustomobject]@{ Idle = $false; Reason = "Desktop is running but desktop status source is missing" } }
        $statuses = $response.Content | ConvertFrom-Json
        if ($null -eq $statuses -or $statuses -is [Array] -or $statuses -isnot [pscustomobject]) { return [pscustomobject]@{ Idle = $false; Reason = "malformed status payload" } }
        foreach ($property in $statuses.PSObject.Properties) {
            if ($property.Value -isnot [pscustomobject] -or $property.Value.type -notin @("idle", "retry")) {
                return [pscustomobject]@{ Idle = $false; Reason = "busy or unknown session status" }
            }
        }
        return [pscustomobject]@{ Idle = $true; Reason = "" }
    } catch {
        return [pscustomobject]@{ Idle = $false; Reason = "strict status request failed" }
    }
}

function Open-SkynetMaintenance {
    try {
        $body = @{ scope = "all"; durationMinutes = 10; reason = "upgrade opencode-remote Windows CLI" } | ConvertTo-Json -Compress
        $response = Invoke-RestMethod -UseBasicParsing -Method Post -Uri $maintenanceUrl -ContentType "application/json" -Body $body -TimeoutSec 10
        if ([string]$response.id -match '^[1-9]\d*$') { return [string]$response.id }
    } catch { Write-UpdateLog "WARNING Skynet maintenance could not be opened." }
    return $null
}

function Close-SkynetMaintenance {
    if (-not $maintenanceId) { return }
    try {
        Invoke-WebRequest -UseBasicParsing -Method Delete -Uri "$maintenanceUrl/$maintenanceId" -TimeoutSec 10 | Out-Null
        Write-UpdateLog "Skynet maintenance $maintenanceId closed."
        $script:maintenanceId = $null
    } catch { Write-UpdateLog "WARNING Skynet maintenance $maintenanceId close failed." }
}

function Restore-PriorPointer([pscustomobject]$Journal) {
    if ($Journal.priorPointerExisted) { Write-AtomicUtf8File $paths.ActivePointer ([string]$Journal.priorPointerContent) }
    elseif (Test-Path -LiteralPath $paths.ActivePointer) { Remove-Item -LiteralPath $paths.ActivePointer -Force -ErrorAction Stop }
}

function Start-VerifiedRemote([string]$ExpectedVersion) {
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $repoRoot "start.ps1"),
        "-NoPrepare", "-InternalSkipLifecycleLock"
    ) -WindowStyle Hidden -PassThru
    if (-not (Wait-OpenCodeRemoteRuntime $configuration $ExpectedVersion $probeFile)) {
        throw "Remote start did not verify version $ExpectedVersion and exact probe; starter PID $($process.Id)."
    }
}

function Write-UpdateBlock([string]$Reason) {
    Write-AtomicUtf8File $paths.BlockFile "automatic updates blocked after failed Windows OpenCode update: $Reason`n"
}

function Invoke-Rollback([pscustomobject]$Journal, [string]$Failure) {
    Stop-OwnedOpenCodeRemote $paths $configuration
    Restore-PriorPointer $Journal
    Start-VerifiedRemote ([string]$Journal.oldVersion)
    Write-UpdateBlock $Failure
    Complete-TransactionFiles ([string]$Journal.token)
    Write-UpdateLog "ROLLBACK restored=$($Journal.oldVersion) reason=$Failure"
    Close-SkynetMaintenance
}

function Test-NewTransactionHealthy([pscustomobject]$Journal) {
    try {
        $candidate = Join-Path (Join-Path $paths.VersionsRoot ([string]$Journal.newVersion)) "node_modules\opencode-ai\bin\opencode.exe"
        $managed = Resolve-ManagedOpenCodeCli $paths
        return $managed -and (Test-ExactPath $managed $candidate) -and
            (Get-ExactCliVersion $managed) -ceq ([string]$Journal.newVersion) -and
            (Test-OpenCodeRemoteRuntime $configuration ([string]$Journal.newVersion) $probeFile)
    } catch { return $false }
}

function Test-PriorTransactionHealthy([pscustomobject]$Journal) {
    try {
        $pointerMatches = if ($Journal.priorPointerExisted) {
            (Test-CurrentUserOwnedRegularFile $paths.ActivePointer) -and
                ((Get-Content -LiteralPath $paths.ActivePointer -Raw) -ceq ([string]$Journal.priorPointerContent))
        } else {
            -not (Test-Path -LiteralPath $paths.ActivePointer)
        }
        return $pointerMatches -and
            ((Get-ExactCliVersion (Resolve-OpenCodeCli $repoRoot)) -ceq ([string]$Journal.oldVersion)) -and
            (Test-OpenCodeRemoteRuntime $configuration ([string]$Journal.oldVersion) $probeFile)
    } catch { return $false }
}

function Recover-InvalidJournal([string]$Failure) {
    $script:probeFile = Ensure-OpenCodeRemoteProbe $configuration
    $currentCli = Resolve-OpenCodeCli $repoRoot
    $currentVersion = Get-ExactCliVersion $currentCli
    if (-not (Test-OpenCodeRemoteRuntime $configuration $currentVersion $probeFile)) {
        throw "Invalid transaction journal cannot be cleared while the current runtime is unverified: $Failure"
    }
    Write-UpdateBlock "invalid transaction journal requires manual review"
    foreach ($path in @($paths.QuiesceFile, $paths.JournalFile)) {
        if (Test-Path -LiteralPath $path) {
            if (-not (Test-CurrentUserOwnedRegularFile $path)) { throw "Refused to clear unowned transaction state." }
            Remove-Item -LiteralPath $path -Force -ErrorAction Stop
        }
    }
    Write-UpdateLog "RECOVERED invalid transaction state without restarting healthy opencode=$currentVersion; automatic updates blocked."
}

function Recover-InterruptedUpdate {
    if (-not (Test-Path -LiteralPath $paths.JournalFile)) {
        Clear-StaleOrphanedQuiesce
        return
    }
    try {
        $journal = Read-UpdateJournal
    } catch {
        Recover-InvalidJournal $_.Exception.Message
        return
    }
    $script:probeFile = Ensure-OpenCodeRemoteProbe $configuration
    if (Test-NewTransactionHealthy $journal) {
        Complete-TransactionFiles ([string]$journal.token)
        Write-UpdateLog "RECOVERED finalized opencode=$($journal.newVersion) after interrupted update."
        return
    }
    if (Test-PriorTransactionHealthy $journal) {
        Complete-TransactionFiles ([string]$journal.token)
        Write-UpdateLog "RECOVERED canceled pre-switch transaction; opencode=$($journal.oldVersion) remained healthy."
        return
    }
    Write-UpdateLog "RECOVERY restoring opencode=$($journal.oldVersion) from interrupted update."
    Stop-OwnedOpenCodeRemote $paths $configuration
    Restore-PriorPointer $journal
    Start-VerifiedRemote ([string]$journal.oldVersion)
    Write-UpdateBlock "interrupted transaction did not verify new runtime"
    Complete-TransactionFiles ([string]$journal.token)
    Write-UpdateLog "RECOVERED rollback opencode=$($journal.oldVersion); automatic updates blocked."
}

function Get-UpdateDecision([string]$Current, [string]$Latest, [bool]$Managed) {
    $output = @(& $node $semverHelper decide $Current $Latest ([string]$Managed).ToLowerInvariant() 2>$null)
    if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1 -or $output[0] -notin @("defer-downgrade", "current", "migrate", "update")) {
        throw "Exact SemVer update decision failed."
    }
    return [string]$output[0]
}

try {
    $updaterMutex = Enter-OpenCodeRemoteMutex -Name Updater -TimeoutMilliseconds 0
    if (-not $updaterMutex) { Write-UpdateLog "DEFERRED reason=updater already running"; exit 0 }
    $lifecycleMutex = Enter-OpenCodeRemoteMutex -Name Lifecycle -TimeoutMilliseconds 0
    if (-not $lifecycleMutex) { Write-UpdateLog "DEFERRED reason=service lifecycle busy"; exit 0 }

    Recover-InterruptedUpdate
    if (Test-Path -LiteralPath $paths.BlockFile) { Write-UpdateLog "DEFERRED reason=automatic updates blocked; run installer manually after recovery"; exit 0 }
    if (-not [string]::IsNullOrWhiteSpace((Get-OpenCodeRemoteEnvValue "OPENCODE_CLI_PATH" "" $repoRoot))) {
        Write-UpdateLog "DEFERRED reason=explicit OPENCODE_CLI_PATH is not managed automatically"; exit 0
    }

    $probeFile = Ensure-OpenCodeRemoteProbe $configuration
    $managedCli = Resolve-ManagedOpenCodeCli $paths
    $currentCli = Resolve-OpenCodeCli $repoRoot
    $oldVersion = Get-ExactCliVersion $currentCli
    if (-not (Test-OpenCodeRemoteRuntime $configuration $oldVersion $probeFile)) { Write-UpdateLog "DEFERRED reason=current health version or exact probe failed"; exit 0 }
    $status = Test-StrictIdle
    if (-not $status.Idle) { Write-UpdateLog "DEFERRED reason=$($status.Reason)"; exit 0 }

    $latestResult = Invoke-BoundedProcess $npm @("view", "opencode-ai", "version", "--json") 30
    if ($latestResult.ExitCode -ne 0) { throw "npm version lookup failed." }
    $latest = $latestResult.Stdout | ConvertFrom-Json
    if ($latest -isnot [string]) { throw "npm returned a non-exact latest version." }
    $decision = Get-UpdateDecision $oldVersion $latest ($null -ne $managedCli)
    if ($decision -eq "defer-downgrade") { Write-UpdateLog "DEFERRED reason=current version $oldVersion is newer than npm latest $latest"; exit 0 }
    if ($decision -eq "current") { Write-UpdateLog "No OpenCode update available; version=$oldVersion"; exit 0 }
    $targetVersion = $latest

    [IO.Directory]::CreateDirectory($paths.VersionsRoot) | Out-Null
    Set-OpenCodeRemotePrivateAcl $paths.RuntimeRoot
    Set-OpenCodeRemotePrivateAcl $paths.CliRoot
    Set-OpenCodeRemotePrivateAcl $paths.VersionsRoot
    if (Test-Path -LiteralPath $paths.ActivePointer) {
        $pointerItem = Get-Item -LiteralPath $paths.ActivePointer -Force
        if ($pointerItem.PSIsContainer -or ($pointerItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Existing active pointer is not a regular non-reparse file." }
        if (-not $managedCli) { throw "Existing active pointer is invalid; refusing to overwrite unknown state." }
    }
    $priorPointerExisted = $null -ne $managedCli
    $priorPointerContent = if ($priorPointerExisted) { Get-Content -LiteralPath $paths.ActivePointer -Raw } else { $null }
    $stageDirectory = Join-Path $paths.CliRoot (".stage-{0}-{1}" -f $targetVersion, [guid]::NewGuid().ToString("N"))
    [IO.Directory]::CreateDirectory($stageDirectory) | Out-Null
    Set-OpenCodeRemotePrivateAcl $stageDirectory
    $install = Invoke-BoundedProcess $npm @("install", "opencode-ai@$targetVersion", "--prefix", $stageDirectory, "--no-save", "--package-lock=false") 600
    if ($install.ExitCode -ne 0) { throw "pinned npm install failed." }
    $stageExecutable = Join-Path $stageDirectory "node_modules\opencode-ai\bin\opencode.exe"
    if (-not (Test-Path -LiteralPath $stageExecutable -PathType Leaf) -or ((Get-Item -LiteralPath $stageExecutable).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "staged CLI executable is missing or reparse-backed." }
    if ((Get-ExactCliVersion $stageExecutable) -cne $targetVersion) { throw "staged CLI version mismatch." }
    $versionDirectory = Join-Path $paths.VersionsRoot $targetVersion
    if (Test-Path -LiteralPath $versionDirectory) {
        $versionItem = Get-Item -LiteralPath $versionDirectory -Force
        if (-not $versionItem.PSIsContainer -or ($versionItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "existing immutable version directory is invalid." }
        $candidate = Join-Path $versionDirectory "node_modules\opencode-ai\bin\opencode.exe"
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf) -or ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-ExactCliVersion $candidate) -cne $targetVersion) { throw "existing immutable version directory is invalid." }
        Remove-Item -LiteralPath $stageDirectory -Recurse -Force
        $stageDirectory = $null
    } else {
        Move-Item -LiteralPath $stageDirectory -Destination $versionDirectory
        $stageDirectory = $null
        $candidate = Join-Path $versionDirectory "node_modules\opencode-ai\bin\opencode.exe"
    }
    Set-OpenCodeRemotePrivateAcl $versionDirectory

    $transactionToken = [guid]::NewGuid().ToString("N")
    $journal = [ordered]@{
        schemaVersion = 1
        token = $transactionToken
        pid = $PID
        oldVersion = $oldVersion
        newVersion = $targetVersion
        priorPointerExisted = $priorPointerExisted
        priorPointerContent = $priorPointerContent
    }
    $currentJournal = [pscustomobject]$journal
    Write-AtomicJsonFile $paths.JournalFile $journal
    $marker = [ordered]@{ pid = $PID; token = $transactionToken; createdAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    if (-not (New-ExclusiveUtf8File $paths.QuiesceFile (($marker | ConvertTo-Json -Compress) + "`n"))) { throw "Update quiesce marker already exists after orphan recovery." }
    Start-Sleep -Seconds 1
    $status = Test-StrictIdle
    if (-not $status.Idle) { Write-UpdateLog "DEFERRED reason=$($status.Reason) after quiesce"; exit 0 }

    $maintenanceId = Open-SkynetMaintenance
    $serviceMutationStarted = $true
    Stop-OwnedOpenCodeRemote $paths $configuration
    $pointerSwitched = $true
    Write-AtomicJsonFile $paths.ActivePointer @{ schemaVersion = 1; version = $targetVersion; executablePath = $candidate }
    Start-VerifiedRemote $targetVersion
    $updateVerified = $true
    Remove-Item -LiteralPath $paths.BlockFile -Force -ErrorAction SilentlyContinue
    Complete-TransactionFiles $transactionToken
    Write-UpdateLog "UPDATED opencode=$targetVersion health=healthy probe=verified"
    Close-SkynetMaintenance
    exit 0
} catch {
    $failure = $_.Exception.Message
    Write-UpdateLog "FAILED reason=$failure"
    if ($pointerSwitched -and -not $updateVerified -and $oldVersion -and $transactionToken) {
        try {
            Invoke-Rollback $currentJournal $failure
        } catch {
            $leaveMaintenance = $true
            Write-UpdateLog "ROLLBACK_FAILED old_version=$oldVersion reason=$($_.Exception.Message)"
        }
    } elseif ($pointerSwitched -and $updateVerified) {
        Write-UpdateLog "RECOVERY_PENDING new runtime verified; journal retained for deterministic finalize."
    } elseif ($serviceMutationStarted -and $oldVersion) {
        try {
            if (-not (Test-OpenCodeRemoteRuntime $configuration $oldVersion $probeFile)) {
                Stop-OwnedOpenCodeRemote $paths $configuration
                Start-VerifiedRemote $oldVersion
            }
        } catch {
            Write-UpdateLog "SERVICE_RECOVERY_FAILED old_version=$oldVersion reason=$($_.Exception.Message)"
        }
    }
    exit 1
} finally {
    if ($stageCleanupSafe -and $stageDirectory -and (Split-Path -Leaf $stageDirectory).StartsWith(".stage-") -and (Test-Path -LiteralPath $stageDirectory) -and (Test-PathWithin $stageDirectory $paths.CliRoot)) {
        Remove-Item -LiteralPath $stageDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($transactionToken -and -not $pointerSwitched) {
        if (-not (Remove-OwnedTransactionFile $paths.QuiesceFile $transactionToken)) { Write-UpdateLog "WARNING owned quiesce cleanup deferred." }
        if (-not (Remove-OwnedTransactionFile $paths.JournalFile $transactionToken)) { Write-UpdateLog "WARNING owned journal cleanup deferred." }
    }
    if (-not $leaveMaintenance) { Close-SkynetMaintenance }
    Exit-OpenCodeRemoteMutex $lifecycleMutex
    Exit-OpenCodeRemoteMutex $updaterMutex
}
