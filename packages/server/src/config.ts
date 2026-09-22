const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const opencodePort = parseNumber(process.env.OPENCODE_PORT, 4096);

// OpenCode 2.x `serve` forces Basic auth; the password is handed to the child
// process and used on every upstream request. Never exposed to the browser.
const envServerPassword = process.env.OPENCODE_SERVER_PASSWORD ?? "";

// Service mode (OPENCODE_SERVICE_MODE=1; the macOS run script sets it): run the very same
// "background service" OpenCode Desktop uses — `opencode serve --service`. The
// CLI records url/password/pid in ~/.local/state/opencode/service.json, only
// one such service exists per user, and whoever starts second (Desktop or us)
// simply reuses the running one. So Desktop and the phone always share one
// engine with no "add server" step and no password to type.
const serviceMode = process.env.OPENCODE_SERVICE_MODE === "1";
export const SERVICE_STATE_PATH = process.env.OPENCODE_SERVICE_STATE ??
  join(homedir(), ".local", "state", "opencode", "service.json");

export type ServiceState = { url: string; password: string; pid?: number; version?: string };

let serviceCache: { mtimeMs: number; state: ServiceState | undefined } | undefined;
export function readServiceState(): ServiceState | undefined {
  if (!serviceMode) return undefined;
  try {
    const mtimeMs = statSync(SERVICE_STATE_PATH).mtimeMs;
    if (serviceCache && serviceCache.mtimeMs === mtimeMs) return serviceCache.state;
    const raw = JSON.parse(readFileSync(SERVICE_STATE_PATH, "utf8"));
    const state = typeof raw?.url === "string" && typeof raw?.password === "string"
      ? { url: raw.url.replace(/\/+$/, ""), password: raw.password, pid: raw.pid, version: raw.version }
      : undefined;
    serviceCache = { mtimeMs, state };
    return state;
  } catch {
    serviceCache = undefined;
    return undefined;
  }
}

const defaultUpdateQuiesceFile = process.platform === "win32" && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "opencode-remote", "update.quiesce")
  : undefined;

export const config = {
  port: parseNumber(process.env.PORT, 9223),
  bindAddress: process.env.BIND_ADDRESS ?? "0.0.0.0",
  serviceMode,
  get opencodePort(): number {
    const url = readServiceState()?.url;
    if (url) {
      try { return Number(new URL(url).port) || opencodePort; } catch { /* fall through */ }
    }
    return opencodePort;
  },
  get opencodeUrl(): string {
    return readServiceState()?.url ?? `http://127.0.0.1:${opencodePort}`;
  },
  get opencodeServerPassword(): string {
    return readServiceState()?.password ?? envServerPassword;
  },
  opencodeDirectory: process.env.OPENCODE_DIRECTORY ?? process.cwd(),
  sessionRefreshIntervalMs: parseNumber(process.env.SESSION_REFRESH_INTERVAL_MS, 30_000),
  deadStreamWatchdogEnabled: process.env.DEAD_STREAM_WATCHDOG !== "0",
  deadStreamWatchdogIntervalMs: parseNumber(process.env.DEAD_STREAM_WATCHDOG_INTERVAL_MS, 60_000),
  deadStreamWatchdogMinAgeMs: parseNumber(process.env.DEAD_STREAM_WATCHDOG_MIN_AGE_MS, 180_000),
  keyDriftIntervalMs: parseNumber(process.env.OPENCODE_KEY_DRIFT_INTERVAL_MS, 300_000),
  keyDriftRestartCooldownMs: parseNumber(process.env.OPENCODE_KEY_DRIFT_COOLDOWN_MS, 600_000),
  healthWatchdogIntervalMs: parseNumber(process.env.OPENCODE_HEALTH_WATCHDOG_INTERVAL_MS, 20_000),
  healthWatchdogTimeoutMs: parseNumber(process.env.OPENCODE_HEALTH_WATCHDOG_TIMEOUT_MS, 5_000),
  healthWatchdogFailures: parseNumber(process.env.OPENCODE_HEALTH_WATCHDOG_FAILURES, 3),
  healthWatchdogRestartCooldownMs: parseNumber(process.env.OPENCODE_HEALTH_WATCHDOG_COOLDOWN_MS, 120_000),
  updateQuiesceFile: process.env.OPENCODE_UPDATE_QUIESCE_FILE ?? defaultUpdateQuiesceFile,
};
