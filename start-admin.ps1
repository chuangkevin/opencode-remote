# Start opencode-remote with an elevated PowerShell token.

param(
    [switch]$NoPrepare
)

$ErrorActionPreference = "Stop"

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-IsAdministrator)) {
    $arguments = @(
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "`"$PSCommandPath`""
    )
    if ($NoPrepare) {
        $arguments += "-NoPrepare"
    }

    Start-Process -FilePath "powershell.exe" `
        -Verb RunAs `
        -WorkingDirectory $PSScriptRoot `
        -ArgumentList $arguments
    exit 0
}

$startArgs = @()
if ($NoPrepare) {
    $startArgs += "-NoPrepare"
}

& (Join-Path $PSScriptRoot "start.ps1") @startArgs
