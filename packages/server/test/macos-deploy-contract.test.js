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
