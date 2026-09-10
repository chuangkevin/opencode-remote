Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:LifecycleMutexName = "Local\opencode-remote-service-lifecycle"
$script:UpdaterMutexName = "Local\opencode-remote-updater"
$script:ProbeContent = "opencode-remote FDA probe v1"
$script:ExactVersionPattern = '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'

if (-not ("OpenCodeRemote.NativeCommandLine" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

namespace OpenCodeRemote {
    public static class NativeCommandLine {
        [DllImport("shell32.dll", SetLastError = true)]
        private static extern IntPtr CommandLineToArgvW(string commandLine, out int argumentCount);

        [DllImport("kernel32.dll")]
        private static extern IntPtr LocalFree(IntPtr memory);

        public static string[] Split(string commandLine) {
            int count;
            IntPtr pointer = CommandLineToArgvW(commandLine, out count);
            if (pointer == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            try {
                string[] arguments = new string[count];
                for (int index = 0; index < count; index++) {
                    arguments[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, index * IntPtr.Size));
                }
                return arguments;
            } finally {
                LocalFree(pointer);
            }
        }
    }
}
'@
}

function Get-OpenCodeRemotePaths {
    param([string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) { throw "LOCALAPPDATA is required." }
    $runtimeRoot = Join-Path $env:LOCALAPPDATA "opencode-remote"
    [pscustomobject]@{
        RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
        ServerEntry = [IO.Path]::GetFullPath((Join-Path $RepoRoot "packages\server\dist\index.js"))
        EnvFile = [IO.Path]::GetFullPath((Join-Path $RepoRoot ".env"))
        RuntimeRoot = $runtimeRoot
        LogRoot = Join-Path $runtimeRoot "logs"
        CliRoot = Join-Path $runtimeRoot "cli"
        VersionsRoot = Join-Path $runtimeRoot "cli\versions"
        ActivePointer = Join-Path $runtimeRoot "cli\active.json"
        QuiesceFile = Join-Path $runtimeRoot "update.quiesce"
        JournalFile = Join-Path $runtimeRoot "update-transaction.json"
        BlockFile = Join-Path $runtimeRoot "update.blocked"
        DesktopState = Join-Path $runtimeRoot "desktop-connection.json"
    }
}

function Get-OpenCodeRemoteEnvValue {
    param([string]$Name, [string]$Fallback, [string]$RepoRoot)
    $processValue = [Environment]::GetEnvironmentVariable($Name, "Process")
    if (-not [string]::IsNullOrWhiteSpace($processValue)) { return $processValue.Trim() }
    $envFile = Join-Path $RepoRoot ".env"
    if (Test-Path -LiteralPath $envFile -PathType Leaf) {
        $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match "^$([regex]::Escape($Name))=" } | Select-Object -First 1
        if ($line) { return ($line -replace "^$([regex]::Escape($Name))=", "").Trim() }
    }
    return $Fallback
}

function Get-OpenCodeRemoteConfiguration {
    param([string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
    $remotePort = 0
    $opencodePort = 0
    if (-not [int]::TryParse((Get-OpenCodeRemoteEnvValue "PORT" "9223" $RepoRoot), [ref]$remotePort) -or $remotePort -lt 1 -or $remotePort -gt 65535) { throw "PORT must be an integer from 1 to 65535." }
    if (-not [int]::TryParse((Get-OpenCodeRemoteEnvValue "OPENCODE_PORT" "4096" $RepoRoot), [ref]$opencodePort) -or $opencodePort -lt 1 -or $opencodePort -gt 65535) { throw "OPENCODE_PORT must be an integer from 1 to 65535." }
    $workspace = Get-OpenCodeRemoteEnvValue "OPENCODE_DIRECTORY" $RepoRoot $RepoRoot
    if (-not [IO.Path]::IsPathRooted($workspace)) { throw "OPENCODE_DIRECTORY must be absolute." }
    [pscustomobject]@{ RemotePort = $remotePort; OpenCodePort = $opencodePort; Workspace = [IO.Path]::GetFullPath($workspace) }
}

function Enter-OpenCodeRemoteMutex {
    param([ValidateSet("Lifecycle", "Updater")][string]$Name, [int]$TimeoutMilliseconds = 0)
    $mutexName = if ($Name -eq "Lifecycle") { $script:LifecycleMutexName } else { $script:UpdaterMutexName }
    $mutex = [Threading.Mutex]::new($false, $mutexName)
    try {
        if (-not $mutex.WaitOne($TimeoutMilliseconds)) { $mutex.Dispose(); return $null }
    } catch [Threading.AbandonedMutexException] {
        # The caller now owns an abandoned mutex and may safely recover.
    }
    return $mutex
}

function Exit-OpenCodeRemoteMutex {
    param([Threading.Mutex]$Mutex)
    if ($null -eq $Mutex) { return }
    try { $Mutex.ReleaseMutex() } finally { $Mutex.Dispose() }
}

function Write-AtomicUtf8File {
    param([string]$Path, [string]$Content)
    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent (".{0}.{1}.{2}.tmp" -f ([IO.Path]::GetFileName($Path)), $PID, [guid]::NewGuid().ToString("N"))
    try {
        [IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($temporary, $Path, $null, $true)
    } catch [IO.FileNotFoundException] {
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    } finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Write-AtomicJsonFile {
    param([string]$Path, [object]$Value)
    Write-AtomicUtf8File -Path $Path -Content (($Value | ConvertTo-Json -Compress -Depth 8) + "`n")
}

function New-ExclusiveUtf8File {
    param([string]$Path, [string]$Content)
    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch [IO.IOException] {
        return $false
    }
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Content)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
        return $true
    } catch {
        $stream.Dispose()
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Set-OpenCodeRemotePrivateAcl {
    param([string]$Path)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [Security.Principal.SecurityIdentifier]::new([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
    $item = Get-Item -LiteralPath $Path -Force
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    if (-not $item.PSIsContainer) { $acl = [Security.AccessControl.FileSecurity]::new(); $inheritance = [Security.AccessControl.InheritanceFlags]::None }
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity, $system)) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance,
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Test-PathWithin {
    param([string]$Path, [string]$Root)
    $candidate = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $parent = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    return $candidate.Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or $candidate.StartsWith($parent + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-ManagedOpenCodeCli {
    param([pscustomobject]$Paths = (Get-OpenCodeRemotePaths))
    try {
        $pointerItem = Get-Item -LiteralPath $Paths.ActivePointer -Force
        if ($pointerItem.PSIsContainer -or ($pointerItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
        if ($pointerItem.Length -gt 16384) { return $null }
        $pointer = Get-Content -LiteralPath $Paths.ActivePointer -Raw | ConvertFrom-Json
        $propertyNames = @($pointer.PSObject.Properties.Name | Sort-Object)
        if (($propertyNames -join ',') -ne 'executablePath,schemaVersion,version') { return $null }
        if ($pointer.schemaVersion -ne 1 -or $pointer.version -notmatch $script:ExactVersionPattern) { return $null }
        if (-not [IO.Path]::IsPathRooted([string]$pointer.executablePath) -or [IO.Path]::GetExtension([string]$pointer.executablePath) -ine '.exe') { return $null }
        $versionRoot = Join-Path $Paths.VersionsRoot ([string]$pointer.version)
        if (-not (Test-PathWithin ([string]$pointer.executablePath) $versionRoot)) { return $null }
        foreach ($directory in @($Paths.CliRoot, $Paths.VersionsRoot, $versionRoot)) {
            $directoryItem = Get-Item -LiteralPath $directory -Force
            if (-not $directoryItem.PSIsContainer -or ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
        }
        $realVersions = (Resolve-Path -LiteralPath $Paths.VersionsRoot).ProviderPath
        $realVersion = (Resolve-Path -LiteralPath $versionRoot).ProviderPath
        $realExecutable = (Resolve-Path -LiteralPath ([string]$pointer.executablePath)).ProviderPath
        if (-not (Test-PathWithin $realVersion $realVersions) -or -not (Test-PathWithin $realExecutable $realVersion)) { return $null }
        $executable = Get-Item -LiteralPath ([string]$pointer.executablePath) -Force
        if ($executable.PSIsContainer -or ($executable.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $null }
        return $executable.FullName
    } catch { return $null }
}

function Resolve-OpenCodeCli {
    param([string]$RepoRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)))
    $explicit = Get-OpenCodeRemoteEnvValue "OPENCODE_CLI_PATH" "" $RepoRoot
    if (-not [string]::IsNullOrWhiteSpace($explicit)) { return $explicit }
    $paths = Get-OpenCodeRemotePaths $RepoRoot
    $managed = Resolve-ManagedOpenCodeCli $paths
    if ($managed) { return $managed }
    $legacy = Join-Path $env:LOCALAPPDATA "opencode\opencode-cli.exe"
    if (Test-Path -LiteralPath $legacy -PathType Leaf) { return $legacy }
    return "opencode"
}

function Get-ExactListenerPid {
    param([int]$Port, [string]$Address)
    $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($Address) { $connections = @($connections | Where-Object { $_.LocalAddress -eq $Address }) }
    $ids = @($connections | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
    if ($ids.Count -ne 1) { return $null }
    return $ids[0]
}

function Get-WindowsProcessRecord {
    param([int]$ProcessId)
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Get-CommandExecutablePath {
    param([string]$Command)
    $resolved = Get-Command $Command -ErrorAction Stop
    $path = if ($resolved.Path) { $resolved.Path } elseif ($resolved.Source) { $resolved.Source } else { $null }
    if ([string]::IsNullOrWhiteSpace($path)) { throw "Command does not resolve to an executable path." }
    return [IO.Path]::GetFullPath($path)
}

function Test-ExactPath {
    param([string]$Actual, [string]$Expected)
    if ([string]::IsNullOrWhiteSpace($Actual) -or [string]::IsNullOrWhiteSpace($Expected)) { return $false }
    try {
        return [IO.Path]::GetFullPath($Actual).Equals([IO.Path]::GetFullPath($Expected), [StringComparison]::OrdinalIgnoreCase)
    } catch { return $false }
}

function Get-ProcessArguments {
    param([string]$CommandLine)
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
    return @([OpenCodeRemote.NativeCommandLine]::Split($CommandLine))
}

function Test-OwnedProxyProcess {
    param([int]$ProcessId, [pscustomobject]$Paths)
    $process = Get-WindowsProcessRecord $ProcessId
    if (-not $process) { return $false }
    $node = Get-CommandExecutablePath "node.exe"
    $Arguments = @(Get-ProcessArguments $process.CommandLine)
    return (Test-ExactPath $process.ExecutablePath $node) -and $Arguments.Count -eq 3 -and
        (Test-ExactPath $Arguments[0] $node) -and $Arguments[1] -ceq "--env-file=$($Paths.EnvFile)" -and
        (Test-ExactPath $Arguments[2] $Paths.ServerEntry)
}

function Get-OwnedServiceProcesses {
    param([pscustomobject]$Paths, [pscustomobject]$Configuration)
    $proxyPid = Get-ExactListenerPid -Port $Configuration.RemotePort
    if (-not $proxyPid) { return [pscustomobject]@{ ProxyPid = $null; ChildPid = $null } }
    if (-not (Test-OwnedProxyProcess $proxyPid $Paths)) { throw "Configured proxy port is held by a process not owned by this repository." }
    $childPid = Get-ExactListenerPid -Port $Configuration.OpenCodePort -Address "127.0.0.1"
    if ($childPid) {
        $child = Get-WindowsProcessRecord $childPid
        $expectedCli = Get-CommandExecutablePath (Resolve-OpenCodeCli $Paths.RepoRoot)
        $Arguments = if ($child) { @(Get-ProcessArguments $child.CommandLine) } else { @() }
        if (-not $child -or [int]$child.ParentProcessId -ne $proxyPid -or
            -not (Test-ExactPath $child.ExecutablePath $expectedCli) -or $Arguments.Count -ne 6 -or
            -not (Test-ExactPath $Arguments[0] $expectedCli) -or $Arguments[1] -cne "serve" -or
            $Arguments[2] -cne "--hostname" -or $Arguments[3] -cne "127.0.0.1" -or
            $Arguments[4] -cne "--port" -or $Arguments[5] -cne ([string]$Configuration.OpenCodePort)) {
            throw "Configured OpenCode port is not owned by the exact Remote proxy child."
        }
    }
    return [pscustomobject]@{ ProxyPid = $proxyPid; ChildPid = $childPid }
}

function Stop-OwnedOpenCodeRemote {
    param([pscustomobject]$Paths, [pscustomobject]$Configuration)
    $owned = Get-OwnedServiceProcesses $Paths $Configuration
    if (-not $owned.ProxyPid) {
        if (Get-NetTCPConnection -LocalPort $Configuration.RemotePort -State Listen -ErrorAction SilentlyContinue) {
            throw "Configured proxy port is occupied by an unmanaged listener."
        }
        if (Get-NetTCPConnection -LocalPort $Configuration.OpenCodePort -State Listen -ErrorAction SilentlyContinue) {
            throw "Configured OpenCode port is occupied without the owned proxy parent."
        }
        return
    }
    if ($owned.ChildPid) { Stop-Process -Id $owned.ChildPid -Force -ErrorAction Stop }
    if ($owned.ProxyPid) { Stop-Process -Id $owned.ProxyPid -Force -ErrorAction Stop }
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (-not (Get-NetTCPConnection -LocalPort $Configuration.RemotePort -State Listen -ErrorAction SilentlyContinue) -and
            -not (Get-NetTCPConnection -LocalPort $Configuration.OpenCodePort -State Listen -ErrorAction SilentlyContinue)) { return }
        Start-Sleep -Milliseconds 250
    }
    throw "Owned service listeners did not stop within five seconds."
}

function Ensure-OpenCodeRemoteProbe {
    param([pscustomobject]$Configuration)
    $probeDirectory = Join-Path $Configuration.Workspace ".opencode-remote"
    $probeFile = Join-Path $probeDirectory "remote-fda-probe.txt"
    [IO.Directory]::CreateDirectory($probeDirectory) | Out-Null
    Write-AtomicUtf8File $probeFile $script:ProbeContent
    return $probeFile
}

function Test-OpenCodeRemoteRuntime {
    param([pscustomobject]$Configuration, [string]$ExpectedVersion, [string]$ProbeFile)
    try {
        $health = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$($Configuration.RemotePort)/remote-health" -TimeoutSec 3
        if ($health.proxy -ne "opencode-remote" -or [int]$health.remotePort -ne $Configuration.RemotePort -or
            $health.upstream -ne "http://127.0.0.1:$($Configuration.OpenCodePort)" -or $health.upstreamHealth.healthy -ne $true) { return $false }
        if ($ExpectedVersion -and $health.upstreamHealth.version -ne $ExpectedVersion) { return $false }
        $query = "path=$([Uri]::EscapeDataString($ProbeFile))&directory=$([Uri]::EscapeDataString($Configuration.Workspace))"
        $probe = Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$($Configuration.RemotePort)/file/content?$query" -TimeoutSec 3
        return $probe.type -eq "text" -and $probe.content -ceq $script:ProbeContent
    } catch { return $false }
}

function Wait-OpenCodeRemoteRuntime {
    param([pscustomobject]$Configuration, [string]$ExpectedVersion, [string]$ProbeFile, [int]$Attempts = 30)
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        if (Test-OpenCodeRemoteRuntime $Configuration $ExpectedVersion $ProbeFile) { return $true }
        if ($attempt -lt $Attempts) { Start-Sleep -Seconds 2 }
    }
    return $false
}

Export-ModuleMember -Function *-OpenCodeRemote*, Resolve-ManagedOpenCodeCli, Resolve-OpenCodeCli, Get-ExactListenerPid, Get-WindowsProcessRecord, Get-CommandExecutablePath, Get-ProcessArguments, Test-ExactPath, Test-OwnedProxyProcess, Get-OwnedServiceProcesses, Test-PathWithin, Write-AtomicUtf8File, Write-AtomicJsonFile, New-ExclusiveUtf8File
