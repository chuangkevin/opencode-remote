import path from "node:path";

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
  nativeOpencodeUrl: process.env.NATIVE_OPENCODE_URL ?? "http://127.0.0.1:9527",
  nativeOpencodeUsername: process.env.NATIVE_OPENCODE_USERNAME ?? "",
  nativeOpencodePassword: process.env.NATIVE_OPENCODE_PASSWORD ?? "",
  nativeOpencodePublicPort: parseNumber(process.env.NATIVE_OPENCODE_PUBLIC_PORT, 9527),
  dispatchDirectory: process.env.DISPATCH_DIRECTORY ?? path.resolve(process.cwd(), ".."),
  dispatchTitle: process.env.DISPATCH_TITLE ?? "Dispatch",
};
