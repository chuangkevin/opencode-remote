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
};
