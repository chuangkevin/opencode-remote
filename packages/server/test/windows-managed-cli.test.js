import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";

import { parseManagedCliPointer, resolveManagedWindowsCli, resolveOpenCodeCommand } from "../dist/opencode-command.js";

const version = "1.20.3";

test("managed pointer parser requires exact schema, version, path, and keys", () => {
  const valid = { schemaVersion: 1, version, executablePath: "C:\\managed\\opencode.exe" };
  assert.deepEqual(parseManagedCliPointer(JSON.stringify(valid)), valid);
  for (const value of [
    { ...valid, schemaVersion: 2 },
    { ...valid, version: "latest" },
    { ...valid, version: "01.2.3" },
    { ...valid, version: "1.2.3-01" },
    { ...valid, extra: true },
    { ...valid, executablePath: "" },
  ]) assert.equal(parseManagedCliPointer(JSON.stringify(value)), undefined);
  assert.equal(parseManagedCliPointer("not-json"), undefined);
});

test("managed pointer accepts only a real regular exe inside its exact immutable version directory", async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), "opencode-managed-"));
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(localAppData, { recursive: true, force: true })));
  const cliRoot = join(localAppData, "opencode-remote", "cli");
  const versionRoot = join(cliRoot, "versions", version);
  const executablePath = join(versionRoot, "node_modules", "opencode-ai", "bin", "opencode.exe");
  await mkdir(join(executablePath, ".."), { recursive: true });
  await writeFile(executablePath, "fixture");
  const pointerPath = join(cliRoot, "active.json");
  const writePointer = (pathValue) => writeFile(pointerPath, JSON.stringify({ schemaVersion: 1, version, executablePath: pathValue }));
  await writePointer(executablePath);
  assert.equal(resolveManagedWindowsCli({ localAppData, pathApi: path }), executablePath);

  await writePointer(join(cliRoot, "versions", "1.20.4", "opencode.exe"));
  assert.equal(resolveManagedWindowsCli({ localAppData, pathApi: path }), undefined);
  await writePointer(join(versionRoot, "..", "outside.exe"));
  assert.equal(resolveManagedWindowsCli({ localAppData, pathApi: path }), undefined);

  const linkPath = join(versionRoot, "linked.exe");
  try {
    await symlink(executablePath, linkPath);
    await writePointer(linkPath);
    assert.equal(resolveManagedWindowsCli({ localAppData, pathApi: path }), undefined);
  } catch (error) {
    if (!["EPERM", "ENOSYS"].includes(error.code)) throw error;
  }
});

test("managed pointer rejects a reparse-style versions root escape", async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), "opencode-managed-root-"));
  const outside = await mkdtemp(join(tmpdir(), "opencode-managed-outside-"));
  t.after(async () => import("node:fs/promises").then(({ rm }) => Promise.all([
    rm(localAppData, { recursive: true, force: true }), rm(outside, { recursive: true, force: true }),
  ])));
  const cliRoot = join(localAppData, "opencode-remote", "cli");
  const outsideVersion = join(outside, version);
  const executablePath = join(cliRoot, "versions", version, "opencode.exe");
  await mkdir(outsideVersion, { recursive: true });
  await mkdir(cliRoot, { recursive: true });
  await writeFile(join(outsideVersion, "opencode.exe"), "fixture");
  try {
    await symlink(outside, join(cliRoot, "versions"), "dir");
  } catch (error) {
    if (["EPERM", "ENOSYS"].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`);
    throw error;
  }
  await writeFile(join(cliRoot, "active.json"), JSON.stringify({ schemaVersion: 1, version, executablePath }));
  assert.equal(resolveManagedWindowsCli({ localAppData, pathApi: path }), undefined);
});

test("Windows command resolution preserves explicit, managed, legacy, then PATH order", async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), "opencode-resolution-"));
  t.after(async () => import("node:fs/promises").then(({ rm }) => rm(localAppData, { recursive: true, force: true })));
  const legacy = join(localAppData, "opencode", "opencode-cli.exe");
  await mkdir(join(legacy, ".."), { recursive: true });
  await writeFile(legacy, "legacy");
  assert.equal(resolveOpenCodeCommand({ platform: "win32", localAppData, explicitPath: "D:\\explicit.exe", pathApi: path }), "D:\\explicit.exe");
  assert.equal(resolveOpenCodeCommand({ platform: "win32", localAppData, pathApi: path }), legacy);
  assert.equal(resolveOpenCodeCommand({ platform: "darwin", localAppData, pathApi: path }), "opencode");
  assert.equal(resolveOpenCodeCommand({ platform: "win32", localAppData: "", pathApi: path }), "opencode");
});
