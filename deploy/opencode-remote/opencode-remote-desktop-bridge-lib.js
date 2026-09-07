import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DESKTOP_CONNECTION_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode-remote",
  "desktop-connection.json",
);

export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;
const HEARTBEAT_STATE = Symbol.for("opencode-remote.desktop-connection-heartbeat");

export function isLoopbackServerUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}

export async function writeDesktopConnection(connection, filePath = DESKTOP_CONNECTION_PATH) {
  const runtimeDirectory = dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  await chmod(runtimeDirectory, 0o700);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(connection)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

export function scheduleDesktopConnectionHeartbeat(connection, options = {}) {
  const globalObject = options.globalObject ?? globalThis;
  const existing = globalObject[HEARTBEAT_STATE];
  if (existing) {
    existing.connection = connection;
    return existing.timer;
  }

  const state = { connection, timer: undefined };
  const writeFn = options.writeFn ?? writeDesktopConnection;
  const nowFn = options.nowFn ?? Date.now;
  const setIntervalFn = options.setIntervalFn ?? globalThis.setInterval.bind(globalThis);
  state.timer = setIntervalFn(() => {
    void Promise.resolve()
      .then(() => writeFn({ ...state.connection, updatedAt: nowFn() }))
      .catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);
  globalObject[HEARTBEAT_STATE] = state;
  state.timer?.unref?.();
  return state.timer;
}

export async function initializeDesktopBridge(input, options = {}) {
  const env = options.env ?? process.env;
  if (env.OPENCODE_CLIENT !== "desktop") return {};

  const username = env.OPENCODE_SERVER_USERNAME;
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!username || !password || !isLoopbackServerUrl(input.serverUrl)) return {};

  const serverUrl = input.serverUrl instanceof URL ? input.serverUrl : new URL(input.serverUrl);
  const connection = {
    origin: serverUrl.origin,
    username,
    password,
    pid: options.pid ?? process.pid,
    updatedAt: (options.nowFn ?? Date.now)(),
  };
  (options.scheduleFn ?? scheduleDesktopConnectionHeartbeat)(connection);
  try {
    await (options.writeFn ?? writeDesktopConnection)(connection);
  } catch {
    // Runtime state is opportunistic; Desktop startup must not depend on it.
  }
  return {};
}
