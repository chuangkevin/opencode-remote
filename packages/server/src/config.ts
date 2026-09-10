const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

import { join } from "node:path";

const opencodePort = parseNumber(process.env.OPENCODE_PORT, 4096);

const defaultUpdateQuiesceFile = process.platform === "win32" && process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "opencode-remote", "update.quiesce")
  : undefined;

export const config = {
  port: parseNumber(process.env.PORT, 9223),
  bindAddress: process.env.BIND_ADDRESS ?? "0.0.0.0",
  opencodePort,
  opencodeUrl: `http://127.0.0.1:${opencodePort}`,
  opencodeDirectory: process.env.OPENCODE_DIRECTORY ?? process.cwd(),
  sessionRefreshIntervalMs: parseNumber(process.env.SESSION_REFRESH_INTERVAL_MS, 30_000),
  deadStreamWatchdogEnabled: process.env.DEAD_STREAM_WATCHDOG !== "0",
  deadStreamWatchdogIntervalMs: parseNumber(process.env.DEAD_STREAM_WATCHDOG_INTERVAL_MS, 60_000),
  deadStreamWatchdogMinAgeMs: parseNumber(process.env.DEAD_STREAM_WATCHDOG_MIN_AGE_MS, 180_000),
  updateQuiesceFile: process.env.OPENCODE_UPDATE_QUIESCE_FILE ?? defaultUpdateQuiesceFile,
};
