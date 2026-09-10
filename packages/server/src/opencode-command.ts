import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

type PathApi = Pick<typeof import("node:path"), "isAbsolute" | "join" | "relative" | "resolve" | "sep">;
type FileApi = {
  existsSync: typeof existsSync;
  lstatSync: typeof lstatSync;
  readFileSync: typeof readFileSync;
  realpathSync: typeof realpathSync;
  statSync: typeof statSync;
};

type ManagedCliOptions = {
  localAppData: string;
  fileApi?: FileApi;
  pathApi?: PathApi;
};

type CommandOptions = ManagedCliOptions & {
  explicitPath?: string;
  platform?: NodeJS.Platform;
};

function isWithin(value: string, root: string, pathApi: PathApi): boolean {
  const fromRoot = pathApi.relative(pathApi.resolve(root), pathApi.resolve(value));
  return fromRoot === "" ||
    (!pathApi.isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${pathApi.sep}`));
}

export function parseManagedCliPointer(raw: string): { schemaVersion: 1; version: string; executablePath: string } | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    if (Object.keys(value).sort().join(",") !== "executablePath,schemaVersion,version") return undefined;
    if (value.schemaVersion !== 1 || typeof value.version !== "string" || !EXACT_VERSION.test(value.version)) return undefined;
    if (typeof value.executablePath !== "string" || value.executablePath.length === 0) return undefined;
    return { schemaVersion: 1, version: value.version, executablePath: value.executablePath };
  } catch {
    return undefined;
  }
}

export function resolveManagedWindowsCli(options: ManagedCliOptions): string | undefined {
  if (!options.localAppData || !(options.pathApi ?? { isAbsolute }).isAbsolute(options.localAppData)) return undefined;
  const fileApi = options.fileApi ?? { existsSync, lstatSync, readFileSync, realpathSync, statSync };
  const pathApi = options.pathApi ?? { isAbsolute, join, relative, resolve, sep };
  const cliRoot = pathApi.join(options.localAppData, "opencode-remote", "cli");
  const pointerPath = pathApi.join(cliRoot, "active.json");
  try {
    const pointerInfo = fileApi.lstatSync(pointerPath);
    if (!pointerInfo.isFile() || pointerInfo.isSymbolicLink() || pointerInfo.size > 16 * 1024) return undefined;
    const pointer = parseManagedCliPointer(fileApi.readFileSync(pointerPath, "utf8"));
    if (!pointer || !pathApi.isAbsolute(pointer.executablePath) || !pointer.executablePath.toLowerCase().endsWith(".exe")) return undefined;

    const versionsRoot = pathApi.join(cliRoot, "versions");
    const versionRoot = pathApi.join(versionsRoot, pointer.version);
    if (!isWithin(pointer.executablePath, versionRoot, pathApi)) return undefined;

    for (const directory of [cliRoot, versionsRoot, versionRoot]) {
      const directoryInfo = fileApi.lstatSync(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return undefined;
    }

    const versionsReal = fileApi.realpathSync(versionsRoot);
    const versionReal = fileApi.realpathSync(versionRoot);
    const executableReal = fileApi.realpathSync(pointer.executablePath);
    if (!isWithin(versionReal, versionsReal, pathApi) || !isWithin(executableReal, versionReal, pathApi)) return undefined;
    const executableLinkInfo = fileApi.lstatSync(pointer.executablePath);
    const executableInfo = fileApi.statSync(pointer.executablePath);
    if (executableLinkInfo.isSymbolicLink() || !executableInfo.isFile()) return undefined;
    return pointer.executablePath;
  } catch {
    return undefined;
  }
}

export function resolveOpenCodeCommand(options: CommandOptions): string {
  if (options.explicitPath) return options.explicitPath;
  if ((options.platform ?? process.platform) !== "win32") return "opencode";
  if (!options.localAppData) return "opencode";

  const managed = resolveManagedWindowsCli(options);
  if (managed) return managed;
  const legacy = (options.pathApi ?? { join }).join(options.localAppData, "opencode", "opencode-cli.exe");
  if ((options.fileApi ?? { existsSync }).existsSync(legacy)) return legacy;
  return "opencode";
}
