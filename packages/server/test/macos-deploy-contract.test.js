import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("macOS deploy installs one plugin wrapper and keeps its private library outside plugin discovery", async () => {
  const source = await readFile(new URL("../../../deploy/macos/deploy-local.sh", import.meta.url), "utf8");
  const wrapper = await readFile(new URL("../../../deploy/macos/opencode-remote-desktop-bridge.js", import.meta.url), "utf8");

  assert.match(source, /\.config\/opencode\/plugins/);
  assert.match(source, /PLUGIN_SOURCE_NAME="opencode-remote-desktop-bridge\.js"/);
  assert.match(source, /BRIDGE_LIB_DIR="\/Users\/kevin\/\.config\/opencode\/opencode-remote"/);
  assert.match(source, /BRIDGE_LIB_SOURCE_NAME="opencode-remote-desktop-bridge-lib\.js"/);
  assert.match(source, /install -d -m 0700/);
  assert.match(source, /install -m 0600 "\$SCRIPT_DIR\/\$PLUGIN_SOURCE_NAME" "\$PLUGIN_DEST"/);
  assert.match(source, /install -m 0600 "\$BRIDGE_LIB_SOURCE" "\$BRIDGE_LIB_DEST"/);
  assert.match(source, /install -m 0600 "\$BRIDGE_LIB_PACKAGE_SOURCE" "\$BRIDGE_LIB_PACKAGE_DEST"/);
  assert.match(source, /^  packages\/server\/dist\/opencode-command\.js \\$/m);
  assert.doesNotMatch(source, /BRIDGE_LIB_DIR=.*plugins/);
  assert.doesNotMatch(source, /rm[^\n]*\.config\/opencode\/plugins/);
  assert.doesNotMatch(source, /opencode\.json/);

  const importPath = wrapper.match(/import\("([^\"]+)"\)/)?.[1];
  assert.ok(importPath);
  const installedWrapper = "/Users/kevin/.config/opencode/plugins/opencode-remote-desktop-bridge.js";
  assert.equal(
    resolve(dirname(installedWrapper), importPath),
    "/Users/kevin/.config/opencode/opencode-remote/opencode-remote-desktop-bridge-lib.js",
  );
  assert.equal(
    resolve(dirname(fileURLToPath(new URL("../../../deploy/macos/opencode-remote-desktop-bridge.js", import.meta.url))), importPath),
    fileURLToPath(new URL("../../../deploy/opencode-remote/opencode-remote-desktop-bridge-lib.js", import.meta.url)),
  );
});

test("macOS wrapper alone configures the fixed updater quiesce marker", async () => {
  const wrapper = await readFile(new URL("../../../deploy/macos/run-opencode-sara.sh", import.meta.url), "utf8");
  const plist = await readFile(new URL("../../../deploy/macos/io.interagent.opencode-sara.plist", import.meta.url), "utf8");

  assert.match(wrapper, /OPENCODE_UPDATE_QUIESCE_FILE="\/Users\/kevin\/\.local\/share\/opencode-remote\/update-opencode-sara\.quiesce"/);
  assert.doesNotMatch(plist, /OPENCODE_UPDATE_QUIESCE_FILE|EnvironmentVariables/);
});

test("macOS deploy tar allowlist covers every compiled server module", async () => {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const source = await readFile(new URL("../../../deploy/macos/deploy-local.sh", import.meta.url), "utf8");
  const dist = new URL("../dist/", import.meta.url);

  const distJs = [];
  const walk = async (dir, prefix) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (entry.isDirectory()) {
        await walk(join(dir, name), `${prefix}${name}/`);
      } else if (name.endsWith(".js") && !name.endsWith(".test.js")) {
        distJs.push(`packages/server/dist/${prefix}${name}`);
      }
    }
  };
  await walk(fileURLToPath(dist), "");

  // Extract the tar file list (entries between `tar -cf ... \` and the closing `)`).
  const tarStart = source.indexOf('tar -cf "$STAGE_ARCHIVE"');
  assert.ok(tarStart >= 0, "deploy-local.sh must contain a tar allowlist");
  const tarEnd = source.indexOf("mockups/compact-mockup.html)");
  assert.ok(tarEnd > tarStart, "tar allowlist must end at mockups/compact-mockup.html");
  const tarBlock = source.slice(tarStart, tarEnd);
  const packed = new Set(tarBlock.match(/packages\/server\/dist\/[^\s\\]+/g) ?? []);

  const missing = distJs.filter((f) => !packed.has(f));
  assert.deepEqual(missing, [], `tar allowlist is missing compiled modules: ${missing.join(", ")}`);
});

test("macOS deploy follows the Desktop-owned OpenCode service, not a fixed 4196", async () => {
  const source = await readFile(new URL("../../../deploy/macos/deploy-local.sh", import.meta.url), "utf8");
  const helper = await readFile(new URL("../../../deploy/macos/update-opencode-sara-json.mjs", import.meta.url), "utf8");

  // Expected upstream comes from the Desktop-owned service.json; missing file is FAIL.
  assert.match(source, /OPENCODE_SERVICE_JSON="\/Users\/kevin\/\.local\/state\/opencode\/service\.json"/);
  assert.match(source, /service_opencode_is_expected/);
  assert.match(source, /opencode-cli serve --service/);
  assert.doesNotMatch(source, /exact_listener_pid "127\.0\.0\.1" 4196/);
  assert.doesNotMatch(source, /\$OPENCODE_BIN serve --hostname/);
  // deploy-health takes the expected upstream as an argument; empty means reject.
  assert.match(helper, /deploymentHealthIsExpected\(raw, expectedUpstreamUrl\)/);
  assert.match(helper, /if \(!expectedUpstreamUrl\) return false/);
  assert.match(helper, /readServiceJsonUrl/);
  assert.doesNotMatch(helper, /127\.0\.0\.1:4196/);
});

test("macOS deploy retries launchctl bootstrap on the bootout race", async () => {
  const source = await readFile(new URL("../../../deploy/macos/deploy-local.sh", import.meta.url), "utf8");
  assert.match(source, /bootstrap race/);
  assert.match(source, /bootstrap_attempt >= 3/);
  assert.match(source, /\/bin\/sleep 2/);
});

test("macOS deploy FDA probe uses the 2.x fs read route", async () => {
  const source = await readFile(new URL("../../../deploy/macos/deploy-local.sh", import.meta.url), "utf8");
  assert.match(source, /FDA_PROBE_API_PATH="api\/fs\/read\/\.opencode-remote\/remote-fda-probe\.txt"/);
  assert.doesNotMatch(source, /FILE_CONTENT_URL=/);
});
