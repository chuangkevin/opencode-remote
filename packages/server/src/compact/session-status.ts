import type http from "node:http";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const DESKTOP_CONNECTION_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode-remote",
  "desktop-connection.json",
);

const MAX_CREDENTIAL_BYTES = 16 * 1024;
const MAX_DIRECTORY_BYTES = 4096;
export const OWN_STATUS_TIMEOUT_MS = 1_500;
export const DESKTOP_STATUS_TIMEOUT_MS = 750;
const CLOCK_SKEW_MS = 60_000;
const MAX_CREDENTIAL_AGE_MS = 15 * 60_000;

export type DesktopConnection = {
  origin: string;
  username: string;
  password: string;
  pid: number;
  updatedAt: number;
};

type SessionStatusMap = Record<string, unknown>;
type FetchFunction = typeof globalThis.fetch;

type MergeOptions = {
  ownOrigin: string;
  desktopConnection?: DesktopConnection;
  strict?: boolean;
  fetchFn?: FetchFunction;
  timeoutMs?: number;
  ownTimeoutMs?: number;
  desktopTimeoutMs?: number;
};

type HandlerOptions = {
  ownOrigin: string;
  allowedRoot: string;
  loadDesktopConnection?: () => Promise<DesktopConnection | undefined>;
  fetchFn?: FetchFunction;
  timeoutMs?: number;
  ownTimeoutMs?: number;
  desktopTimeoutMs?: number;
};

function loopbackOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const hostname = url.hostname.toLowerCase();
    const loopback = hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (!loopback || url.username || url.password || url.origin !== value) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function parseDesktopConnection(raw: string, now = Date.now()): DesktopConnection | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const origin = loopbackOrigin(value.origin);
    if (!origin) return undefined;
    if (typeof value.username !== "string" || value.username.length === 0) return undefined;
    if (typeof value.password !== "string" || value.password.length === 0) return undefined;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    if (!Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) <= 0) return undefined;
    if ((value.updatedAt as number) > now + CLOCK_SKEW_MS) return undefined;
    if ((value.updatedAt as number) < now - MAX_CREDENTIAL_AGE_MS) return undefined;
    return {
      origin,
      username: value.username,
      password: value.password,
      pid: value.pid as number,
      updatedAt: value.updatedAt as number,
    };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function readDesktopConnection(
  filePath = DESKTOP_CONNECTION_PATH,
): Promise<DesktopConnection | undefined> {
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_CREDENTIAL_BYTES) return undefined;
    if ((info.mode & 0o777) !== 0o600) return undefined;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) return undefined;

    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const { bytesRead } = await file.read(buffer, length, buffer.byteLength - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_CREDENTIAL_BYTES) return undefined;

    const connection = parseDesktopConnection(buffer.toString("utf8", 0, length));
    if (!connection || !processIsAlive(connection.pid)) return undefined;
    return connection;
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => {});
  }
}

export function isPathWithinRoot(value: string, allowedRoot: string): boolean {
  if (!isAbsolute(value) || !isAbsolute(allowedRoot)) return false;
  const resolvedRoot = resolve(allowedRoot);
  const resolvedValue = resolve(value);
  const pathFromRoot = relative(resolvedRoot, resolvedValue);
  return pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

function validDirectory(value: string | null, allowedRoot: string): value is string {
  return value !== null && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_DIRECTORY_BYTES &&
    !value.includes("\0") && isPathWithinRoot(value, allowedRoot);
}

function validStatusMap(value: unknown): value is SessionStatusMap {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function fetchStatusMap(
  origin: string,
  directory: string,
  fetchFn: FetchFunction,
  timeoutMs: number,
  connection?: DesktopConnection,
): Promise<SessionStatusMap> {
  const url = new URL("/session/status", origin);
  url.searchParams.set("directory", directory);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = connection
      ? { Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`, "utf8").toString("base64")}` }
      : undefined;
    const response = await fetchFn(url, { signal: controller.signal, headers });
    if (!response.ok) throw new Error("status source unavailable");
    const statuses: unknown = await response.json();
    if (!validStatusMap(statuses)) throw new Error("invalid status payload");
    return statuses;
  } finally {
    clearTimeout(timeout);
  }
}

export async function mergeSessionStatuses(
  directory: string,
  options: MergeOptions,
): Promise<SessionStatusMap> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const ownTimeoutMs = options.ownTimeoutMs ?? options.timeoutMs ?? OWN_STATUS_TIMEOUT_MS;
  const desktopTimeoutMs = options.desktopTimeoutMs ?? options.timeoutMs ?? DESKTOP_STATUS_TIMEOUT_MS;
  const requests = [fetchStatusMap(options.ownOrigin, directory, fetchFn, ownTimeoutMs)];
  if (options.desktopConnection) {
    requests.push(fetchStatusMap(
      options.desktopConnection.origin,
      directory,
      fetchFn,
      desktopTimeoutMs,
      options.desktopConnection,
    ));
  }

  const results = await Promise.allSettled(requests);
  if (options.strict && results.some((result) => result.status === "rejected")) {
    throw new Error("session status unavailable");
  }
  const fulfilled = results
    .filter((result): result is PromiseFulfilledResult<SessionStatusMap> => result.status === "fulfilled")
    .map((result) => result.value);
  if (fulfilled.length === 0) throw new Error("session status unavailable");
  const merged: SessionStatusMap = {};
  for (const statuses of fulfilled) {
    for (const [sessionID, status] of Object.entries(statuses)) {
      const current = merged[sessionID];
      const currentType = current && typeof current === "object" && "type" in current ? current.type : undefined;
      const nextType = status && typeof status === "object" && "type" in status ? status.type : undefined;
      if (currentType === "busy" && nextType !== "busy") continue;
      merged[sessionID] = status;
    }
  }
  return merged;
}

export function isMergedSessionStatusPath(path: string | undefined): boolean {
  if (!path) return false;
  try {
    return new URL(path, "http://localhost").pathname === "/c/session-status";
  } catch {
    return false;
  }
}

export async function handleMergedSessionStatus(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: HandlerOptions,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const strict = url.searchParams.get("strict") === "1";
  const directories = url.searchParams.getAll("directory");
  const requestedDirectory = directories[0] ?? null;
  if (directories.length !== 1 || !validDirectory(requestedDirectory, options.allowedRoot)) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "invalid directory" }));
    return;
  }

  let directory: string;
  try {
    const [realRoot, realDirectory] = await Promise.all([
      realpath(options.allowedRoot),
      realpath(requestedDirectory),
    ]);
    if (!isPathWithinRoot(realDirectory, realRoot)) throw new Error("directory escapes allowed root");
    directory = realDirectory;
  } catch {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "invalid directory" }));
    return;
  }

  try {
    const desktopConnection = await (options.loadDesktopConnection ?? readDesktopConnection)();
    const statuses = await mergeSessionStatuses(directory, {
      ownOrigin: options.ownOrigin,
      desktopConnection,
      strict,
      fetchFn: options.fetchFn,
      timeoutMs: options.timeoutMs,
      ownTimeoutMs: options.ownTimeoutMs,
      desktopTimeoutMs: options.desktopTimeoutMs,
    });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-OpenCode-Remote": "true",
    });
    res.end(JSON.stringify(statuses));
  } catch {
    res.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-OpenCode-Remote": "true",
    });
    res.end(JSON.stringify({ error: "session status unavailable" }));
  }
}
