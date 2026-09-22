import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  newestDesktopCliVersion,
  deploymentHealthIsExpected,
  fileContentMatches,
  healthMatchesVersion,
  inspectSessionStatuses,
  parseMaintenanceId,
} from "../../../deploy/macos/update-opencode-sara-json.mjs";

const updaterUrl = new URL("../../../deploy/macos/update-opencode-sara.sh", import.meta.url);
const plistUrl = new URL("../../../deploy/macos/io.interagent.opencode-sara-updater.plist", import.meta.url);
const deployUrl = new URL("../../../deploy/macos/deploy-local.sh", import.meta.url);

test("session status parsing fails closed and only busy blocks known statuses", () => {
  assert.deepEqual(inspectSessionStatuses("{}"), { valid: true, busy: false });
  assert.deepEqual(inspectSessionStatuses('{"ses_idle":{"type":"idle"},"ses_retry":{"type":"retry"}}'), {
    valid: true,
    busy: false,
  });
  assert.deepEqual(inspectSessionStatuses('{"ses_busy":{"type":"busy"}}'), { valid: true, busy: true });

  for (const payload of ["", "null", "[]", '{"ses":null}', '{"ses":{}}', '{"ses":{"type":"future"}}']) {
    assert.deepEqual(inspectSessionStatuses(payload), { valid: false, busy: false }, payload);
  }
});

test("health parsing requires healthy true and exact upgraded CLI version", () => {
  const expected = JSON.stringify({ upstreamHealth: { healthy: true, version: "1.18.30" } });
  assert.equal(healthMatchesVersion(expected, "1.18.30"), true);
  assert.equal(healthMatchesVersion(expected, "1.18.31"), false);
  assert.equal(healthMatchesVersion('{"upstreamHealth":{"healthy":false,"version":"1.18.30"}}', "1.18.30"), false);
  assert.equal(healthMatchesVersion("not-json", "1.18.30"), false);
});

test("Desktop CLI version picker returns the newest semver and whether it beats the current one", () => {
  assert.deepEqual(newestDesktopCliVersion("2.0.11\n2.0.12\n.DS_Store\n", "2.0.11"), { status: "outdated", newest: "2.0.12" });
  assert.deepEqual(newestDesktopCliVersion("2.0.11\n2.0.9\n", "2.0.11"), { status: "current", newest: "2.0.11" });
  assert.deepEqual(newestDesktopCliVersion("2.0.11\n", "missing"), { status: "outdated", newest: "2.0.11" }, "unparseable current forces the newest");
  assert.deepEqual(newestDesktopCliVersion("", "2.0.11"), { status: "invalid" });
  assert.deepEqual(newestDesktopCliVersion("junk\n", "2.0.11"), { status: "invalid" });
});

test("FDA probe parser accepts the 2.x raw body and the legacy JSON contract", () => {
  const raw = "opencode-remote FDA probe v1";
  assert.equal(fileContentMatches(`${raw}\n`, raw), true, "2.x /api/fs/read returns the body as-is");
  assert.equal(fileContentMatches("something else", raw), false);
  const content = "opencode-remote FDA probe v1";
  assert.equal(fileContentMatches(JSON.stringify({ type: "text", content }), content), true);
  assert.equal(fileContentMatches(JSON.stringify({ type: "text", content: `${content}\n` }), content), false);
  assert.equal(fileContentMatches(JSON.stringify({ type: "binary", content }), content), false);
  assert.equal(fileContentMatches("not-json", content), false);
});

test("deployment health parser requires the exact Remote topology and healthy upstream", () => {
  const expected = {
    proxy: "opencode-remote",
    remotePort: 9223,
    upstream: "http://127.0.0.1:4196",
    upstreamHealth: { healthy: true, version: "1.18.30" },
  };
  assert.equal(deploymentHealthIsExpected(JSON.stringify(expected)), true);
  assert.equal(deploymentHealthIsExpected(JSON.stringify({ ...expected, remotePort: 9224 })), false);
  assert.equal(deploymentHealthIsExpected(JSON.stringify({ ...expected, upstreamHealth: { healthy: false } })), false);
});

test("maintenance ID parsing accepts only a positive integer ID", () => {
  assert.equal(parseMaintenanceId('{"id":"42"}'), "42");
  assert.equal(parseMaintenanceId('{"id":42}'), "42");
  assert.equal(parseMaintenanceId('{"id":"other"}'), undefined);
  assert.equal(parseMaintenanceId("not-json"), undefined);
});

test("updater follows the Desktop-bundled CLI, is version-gated, and closes only its own maintenance window", async () => {
  const source = await readFile(updaterUrl, "utf8");

  assert.doesNotMatch(source, /brew (outdated|upgrade)|BREW_BIN/, "Homebrew is no longer the CLI source");
  assert.match(source, /DESKTOP_CLI_ROOT=.*ai\.opencode\.desktop\/cli/);
  assert.match(source, /desktop-cli-newest "\$current_version"/);
  assert.match(source, /point_run_script_at "\$NEW_VERSION"/);
  assert.match(source, /RUN_SCRIPT_BACKUP/);
  assert.match(source, /forcing update/, "a pruned current version skips the gates");
  assert.match(source, /strict=1/);
  assert.match(source, /QUIESCE_FILE=.*update-opencode-sara\.quiesce/);
  assert.match(source, /\/bin\/sleep 1/);
  assert.match(source, /DEFERRED/);
  assert.match(source, /gui\/\$UID_VALUE\/io\.interagent\.opencode-sara/);
  assert.doesNotMatch(source, /killall|pkill/);
  assert.match(source, /poll_runtime "\$new_version"/);
  assert.match(source, /health-current/, "service mode: healthy upstream, not an exact version match");
  assert.match(source, /file-content "\$FDA_PROBE_CONTENT"/);
  assert.match(source, /FILE_CONTENT_URL=.*\/api\/fs\/read\//);
  assert.match(source, /\/bin\/cp -f "\$RUN_SCRIPT_BACKUP" "\$RUN_SCRIPT"/);
  assert.match(source, /ROLLBACK restored=/);
  assert.match(source, /ROLLBACK_FAILED/);
  assert.match(source, /KEEP_MAINTENANCE=1/);
  assert.match(source, /left to expire after rollback failure/);
  assert.match(source, /UPDATE_BLOCK_FILE/);
  assert.ok(source.indexOf("if ! strict_status_is_idle; then") < source.indexOf('> "$QUIESCE_FILE"'));
  assert.ok(source.lastIndexOf("strict_status_is_idle") < source.indexOf('point_run_script_at "$NEW_VERSION"'));
  assert.match(source, /SKYNET_MAINTENANCE_URL\/\$MAINTENANCE_ID/);
  assert.match(source, /trap cleanup EXIT/);
  assert.match(source, /close_maintenance/);
  assert.doesNotMatch(source, /maintenance\/active/);
});

test("updater plist runs hourly at load with background scheduling and fixed logs", async () => {
  const plist = await readFile(plistUrl, "utf8");

  assert.match(plist, /<string>io\.interagent\.opencode-sara-updater<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key>\s*<integer>3600<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  assert.match(plist, /<key>Nice<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /\/Users\/kevin\/Library\/Logs\/opencode-remote\/opencode-sara-updater\.log/);
  assert.match(plist, /\/Users\/kevin\/Library\/Logs\/opencode-remote\/opencode-sara-updater\.error\.log/);
  assert.doesNotMatch(plist, /EnvironmentVariables|API.Key|Password/i);
});

test("deploy installs updater after main health and replaces only the exact updater label", async () => {
  const source = await readFile(deployUrl, "utf8");
  const mainHealthy = source.indexOf("OpenCode Remote is healthy");
  const updaterBootout = source.indexOf('launchctl bootout "$UPDATER_TARGET"');
  const mainBootout = source.indexOf('launchctl bootout "$SERVICE_TARGET"');
  const updaterInstall = source.indexOf('install -m 0755 "$SCRIPT_DIR/$UPDATER_SOURCE_NAME"');
  const updaterBootstrap = source.indexOf('launchctl bootstrap "$GUI_DOMAIN" "$UPDATER_PLIST_DEST"');
  const probeCreate = source.indexOf('FDA_PROBE_CONTENT');
  const probeGate = source.indexOf('file-content "$FDA_PROBE_CONTENT"');
  const blockRemoval = source.indexOf('rm -f -- "$UPDATE_BLOCK_FILE"');

  assert.ok(mainHealthy >= 0);
  assert.ok(updaterBootout >= 0 && updaterBootout < mainBootout);
  assert.ok(updaterInstall > mainHealthy);
  assert.ok(updaterBootstrap > updaterInstall);
  assert.ok(probeCreate >= 0 && probeCreate < mainHealthy);
  assert.ok(probeGate >= 0 && probeGate < mainHealthy);
  assert.ok(blockRemoval > probeGate && blockRemoval < updaterBootstrap);
  assert.match(source, /FDA_PROBE_FILE="\$FDA_PROBE_DIR\/remote-fda-probe\.txt"/);
  assert.match(source, /chmod 0644 "\$PROBE_TEMP"/);
  assert.doesNotMatch(source, /rm[^\n]*"?\$FDA_PROBE_DIR/);
  assert.match(source, /UPDATER_LABEL="io\.interagent\.opencode-sara-updater"/);
  assert.match(source, /launchctl print "\$UPDATER_TARGET"/);
  assert.match(source, /launchctl bootout "\$UPDATER_TARGET"/);
  assert.match(source, /install -m 0644 "\$SCRIPT_DIR\/\$UPDATER_PLIST_SOURCE_NAME" "\$UPDATER_PLIST_DEST"/);
  assert.match(source, /bash -n "\$SCRIPT_DIR\/\$UPDATER_SOURCE_NAME"/);
  assert.match(source, /--check "\$SCRIPT_DIR\/\$UPDATER_HELPER_SOURCE_NAME"/);
  assert.doesNotMatch(source, /bootout[^\n]*(gui\/\$\(.*\)|gui\/\$UID_VALUE)\s*["']?$/m);
});
