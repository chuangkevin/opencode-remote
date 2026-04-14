const parseNumber = (value: string | undefined, fallback: number) => {
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  port: parseNumber(process.env.PORT, 9223),
  databasePath: process.env.DATABASE_PATH ?? "./data/opencode-remote.db",
  runnerSharedToken: process.env.RUNNER_SHARED_TOKEN ?? "change-this-runner-token",
  sseHeartbeatMs: parseNumber(process.env.SSE_HEARTBEAT_MS, 15000),
};
