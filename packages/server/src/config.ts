const parseNumber = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const opencodePort = parseNumber(process.env.OPENCODE_PORT, 4096);

export const config = {
  port: parseNumber(process.env.PORT, 9223),
  opencodePort,
  opencodeUrl: `http://127.0.0.1:${opencodePort}`,
  opencodeDirectory: process.env.OPENCODE_DIRECTORY ?? process.cwd(),
  sessionRefreshIntervalMs: parseNumber(process.env.SESSION_REFRESH_INTERVAL_MS, 30_000),
  deadStreamWatchdogEnabled: process.env.DEAD_STREAM_WATCHDOG !== "0",
  deadStreamWatchdogIntervalMs: parseNumber(process.env.DEAD_STREAM_WATCHDOG_INTERVAL_MS, 60_000),
  deadStreamWatchdogMinAgeMs: parseNumber(process.env.DEAD_STREAM_WATCHDOG_MIN_AGE_MS, 180_000),
};
