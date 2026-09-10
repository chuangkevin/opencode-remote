import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const file = (path) => readFile(new URL(path, root), "utf8");

test("Windows lifecycle uses configured ports, shared locks, and no broad process sweep or fallback port", async () => {
  const [runtime, start, stop, restart, watchdog] = await Promise.all([
    file("deploy/windows/opencode-remote-runtime.psm1"), file("start.ps1"), file("stop.ps1"),
    file("restart-service.ps1"), file("ensure-service.ps1"),
  ]);
  const combined = [runtime, start, stop, restart, watchdog].join("\n");
  assert.match(runtime, /Local\\opencode-remote-service-lifecycle/);
  assert.match(runtime, /ParentProcessId/);
  assert.match(runtime, /ServerEntry/);
  assert.match(runtime, /\$Arguments\[1\] -cne "serve"[\s\S]*\$Arguments\[2\] -cne "--hostname"[\s\S]*\$Arguments\[3\] -cne "127\.0\.0\.1"[\s\S]*\$Arguments\[4\] -cne "--port"/);
  assert.match(combined, /Get-OpenCodeRemoteConfiguration/);
  assert.doesNotMatch(combined, /Get-Process\s+-Name\s+["'](?:opencode|OpenCode)\*/i);
  assert.doesNotMatch(combined, /Get-AvailablePort|fallbackPort|Stop-PortProcess/);
  assert.doesNotMatch(combined, /Where-Object\s*\{\s*\$_.Path\s+-like/i);
});

test("Windows updater orders health, strict idle, pinned staging, quiesce recheck, switch, and exact verification", async () => {
  const [source, runtime] = await Promise.all([
    file("deploy/windows/update-opencode-remote.ps1"),
    file("deploy/windows/opencode-remote-runtime.psm1"),
  ]);
  const beforeHealth = source.indexOf("Test-OpenCodeRemoteRuntime $configuration $oldVersion");
  const firstStatus = source.indexOf("$status = Test-StrictIdle", beforeHealth);
  const npmLookup = source.indexOf('"view", "opencode-ai", "version", "--json"');
  const pinnedInstall = source.indexOf('"install", "opencode-ai@$targetVersion"');
  const quiesce = source.indexOf("New-ExclusiveUtf8File $paths.QuiesceFile");
  const secondStatus = source.indexOf("$status = Test-StrictIdle", firstStatus + 1);
  const switchPointer = source.indexOf("Write-AtomicJsonFile $paths.ActivePointer");
  const verifyNew = source.indexOf("Start-VerifiedRemote $targetVersion");
  assert.ok(beforeHealth >= 0 && beforeHealth < firstStatus);
  assert.ok(firstStatus < npmLookup && npmLookup < pinnedInstall && pinnedInstall < quiesce);
  assert.ok(quiesce < secondStatus && secondStatus < switchPointer && switchPointer < verifyNew);
  assert.match(source, /--no-save/);
  assert.match(source, /--package-lock=false/);
  assert.match(runtime, /Local\\opencode-remote-updater/);
  assert.match(source, /X-OpenCode-Status-Sources/);
  assert.match(source, /Test-DesktopRunning/);
  assert.match(source, /Start-Sleep -Seconds 1/);
  assert.match(source, /New-ExclusiveUtf8File \$paths.QuiesceFile/);
  assert.doesNotMatch(source, /npm\s+(?:i|install)\s+-g|--global|Desktop.*Stop-Process/i);
});

test("Windows updater rollback restores absent or prior pointer, blocks retries, and preserves immutable versions", async () => {
  const source = await file("deploy/windows/update-opencode-remote.ps1");
  assert.match(source, /automatic updates blocked after failed Windows OpenCode update/);
  assert.match(source, /if \(\$Journal\.priorPointerExisted\).*Write-AtomicUtf8File/s);
  assert.match(source, /elseif \(Test-Path -LiteralPath \$paths.ActivePointer\).*Remove-Item/s);
  assert.match(source, /Restore-PriorPointer \$Journal[\s\S]*Start-VerifiedRemote \(\[string\]\$Journal\.oldVersion\)/);
  assert.match(source, /ROLLBACK restored=/);
  assert.match(source, /ROLLBACK_FAILED/);
  assert.match(source, /leaveMaintenance = \$true/);
  assert.doesNotMatch(source, /Remove-Item[^\n]*VersionsRoot[^\n]*-Recurse/i);
});

test("Windows updater recovers owned journals before block checks and cleans only matching transaction files", async () => {
  const [source, runtime] = await Promise.all([
    file("deploy/windows/update-opencode-remote.ps1"),
    file("deploy/windows/opencode-remote-runtime.psm1"),
  ]);
  const locks = source.indexOf("$lifecycleMutex = Enter-OpenCodeRemoteMutex");
  const recover = source.indexOf("\n    Recover-InterruptedUpdate\n", locks);
  const block = source.indexOf("Test-Path -LiteralPath $paths.BlockFile", recover);
  const journal = source.indexOf("Write-AtomicJsonFile $paths.JournalFile");
  const quiesce = source.indexOf("New-ExclusiveUtf8File $paths.QuiesceFile");
  assert.match(runtime, /JournalFile\s*=.*update-transaction\.json/);
  assert.ok(recover >= 0 && recover < block);
  assert.ok(journal >= 0 && journal < quiesce);
  assert.match(source, /schemaVersion\s*=\s*1[\s\S]*token[\s\S]*oldVersion[\s\S]*newVersion[\s\S]*priorPointerExisted[\s\S]*priorPointerContent/);
  assert.match(source, /Remove-OwnedTransactionFile[^\n]*\$paths\.JournalFile[^\n]*\$transactionToken/);
  assert.match(source, /Remove-OwnedTransactionFile[^\n]*\$paths\.QuiesceFile[^\n]*\$transactionToken/);
  assert.match(source, /createdAt/);
  assert.match(source, /Test-PriorTransactionHealthy/);
  assert.match(source, /RECOVERED canceled pre-switch transaction/);
  assert.match(source, /Recover-InvalidJournal/);
  assert.match(source, /invalid transaction state without restarting healthy/);

  const recoveryBody = source.slice(source.indexOf("function Recover-InterruptedUpdate"), source.indexOf("function Get-UpdateDecision"));
  const unhealthyStop = recoveryBody.lastIndexOf("Stop-OwnedOpenCodeRemote");
  const restore = recoveryBody.lastIndexOf("Restore-PriorPointer");
  const restart = recoveryBody.lastIndexOf("Start-VerifiedRemote");
  const persistBlock = recoveryBody.lastIndexOf("Write-UpdateBlock");
  const cleanup = recoveryBody.lastIndexOf("Complete-TransactionFiles");
  assert.ok(unhealthyStop < restore && restore < restart && restart < persistBlock && persistBlock < cleanup);
});

test("Windows updater uses switch-aware rollback, tree termination, and best-effort logging", async () => {
  const source = await file("deploy/windows/update-opencode-remote.ps1");
  assert.doesNotMatch(source, /transactionStarted/);
  assert.match(source, /\$pointerSwitched\s*=\s*\$false/);
  assert.match(source, /if \(\$pointerSwitched -and -not \$updateVerified/);
  assert.match(source, /taskkill\.exe[\s\S]*\/PID[\s\S]*\/T[\s\S]*\/F/);
  assert.match(source, /Get-ExactProcessTreeIds \$process\.Id[\s\S]*foreach \(\$processId in \$treeProcessIds\)[\s\S]*Get-Process -Id \$processId/);
  assert.match(source, /stageCleanupSafe = \$false/);
  assert.match(source, /WaitForExit\(30000\)/);
  assert.doesNotMatch(source, /\$process\.Kill\(/);
  assert.match(source, /function Write-UpdateLog[\s\S]*catch \{/);
  assert.ok(source.indexOf('Write-UpdateLog "FAILED') < source.indexOf("Invoke-Rollback $currentJournal $failure"));
  const stage = source.indexOf('$stageDirectory = Join-Path $paths.CliRoot');
  const serviceMutation = source.indexOf("$serviceMutationStarted = $true", stage);
  const pointerSwitch = source.indexOf("$pointerSwitched = $true", serviceMutation);
  assert.ok(stage < serviceMutation && serviceMutation < pointerSwitch);
});

test("Windows updater wires full semver decisions without an equality downgrade shortcut", async () => {
  const source = await file("deploy/windows/update-opencode-remote.ps1");
  assert.match(source, /Get-UpdateDecision \$oldVersion \$latest \(\$null -ne \$managedCli\)/);
  assert.match(source, /if \(\$decision -eq "defer-downgrade"\)[\s\S]*exit 0/);
  assert.match(source, /if \(\$decision -eq "current"\)[\s\S]*exit 0/);
  assert.match(source, /\$targetVersion = \$latest[\s\S]*"opencode-ai@\$targetVersion"/);
  assert.doesNotMatch(source, /if \(\$latest -eq \$oldVersion\)/);
  assert.match(source, /Existing active pointer is invalid; refusing to overwrite unknown state/);
});

test("Windows scripts fail closed on build errors and require exact process identity", async () => {
  const [runtime, start, hidden] = await Promise.all([
    file("deploy/windows/opencode-remote-runtime.psm1"), file("start.ps1"), file("start-hidden.ps1"),
  ]);
  for (const source of [start, hidden]) {
    const build = source.indexOf("npm run build");
    const check = source.indexOf("$LASTEXITCODE", build);
    assert.ok(build >= 0 && check > build && check - build < 180);
  }
  assert.match(runtime, /CommandLineToArgvW/);
  assert.match(runtime, /\.ExecutablePath/);
  assert.match(runtime, /Resolve-OpenCodeCli/);
  assert.match(runtime, /Arguments\.Count/);
  assert.doesNotMatch(runtime, /CommandLine -match \[regex\]::Escape\(\$Paths\.ServerEntry\)/);
});

test("Windows hidden updater runner is synchronous", async () => {
  const source = await file("deploy/windows/run-opencode-updater-hidden.vbs");
  assert.match(source, /WScript\.Quit\s+shell\.Run\(command,\s*0,\s*True\)/i);
  assert.doesNotMatch(source, /shell\.Run command, 0, False/i);
});

test("Windows updater installer preserves plugins, applies private ACL, and registers a bounded current-user task", async () => {
  const [source, watchdog] = await Promise.all([
    file("deploy/windows/install-opencode-updater.ps1"), file("install-watchdog.ps1"),
  ]);
  const health = source.indexOf("Test-OpenCodeRemoteRuntime");
  const register = source.indexOf("Register-ScheduledTask");
  const unlock = source.indexOf("Exit-OpenCodeRemoteMutex $lifecycleMutex");
  const immediate = source.indexOf("Start-ScheduledTask -TaskName $taskName");
  assert.ok(health >= 0 && health < register);
  assert.ok(register < unlock && unlock < immediate);
  assert.match(source, /opencode-remote-updater/);
  assert.match(source, /<LogonTrigger>[\s\S]*<UserId>\$userSid<\/UserId>[\s\S]*<\/LogonTrigger>/);
  assert.match(source, /<Interval>PT1H<\/Interval>/);
  assert.match(source, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(source, /<ExecutionTimeLimit>PT20M<\/ExecutionTimeLimit>/);
  assert.match(source, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.doesNotMatch(source, /RepetitionDuration|3650/);
  assert.match(source, /Set-OpenCodeRemotePrivateAcl/);
  assert.match(source, /opencode-remote-desktop-bridge-lib\.js/);
  assert.match(source, /package\.json/);
  assert.doesNotMatch(source, /Remove-Item[^\n]*(?:plugins|opencode\.json)/i);
  assert.doesNotMatch(source, /Password|Credential/);
  assert.match(watchdog, /schtasks\.exe \/Create[\s\S]*\$LASTEXITCODE/);
  assert.match(watchdog, /schtasks\.exe \/Run[\s\S]*\$LASTEXITCODE/);
});

test("atomic file writes pass a real null backup name so PowerShell 5.1 does not break the watchdog", async () => {
  const runtime = await file("deploy/windows/opencode-remote-runtime.psm1");

  // 2026-09-10 kevinhome 實機：watchdog 每 5 分鐘失敗，錯誤是
  // 「以 4 引數呼叫 Replace 時發生例外狀況：不合法的路徑格式」。
  // Windows PowerShell 5.1 把 $null 綁成空字串，File.Replace 會正規化全部三個路徑，
  // 空字串的備份檔名就丟 ArgumentException。PowerShell 7 不會，所以在 pwsh 測不出來。
  assert.match(runtime, /\[IO\.File\]::Replace\(\$temporary, \$Path, \[NullString\]::Value, \$true\)/);
  assert.doesNotMatch(runtime, /\[IO\.File\]::Replace\([^)]*\$null[^)]*\)/);

  // 目的檔不存在時 Replace 會丟 FileNotFoundException，必須有 Move-Item 的退路。
  assert.match(runtime, /catch \[IO\.FileNotFoundException\][\s\S]{0,160}Move-Item/);
});
