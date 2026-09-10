import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const KNOWN_STATUS_TYPES = new Set(["busy", "idle", "retry"]);

function parseObject(raw) {
  try {
    const value = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function inspectSessionStatuses(raw) {
  const statuses = parseObject(raw);
  if (!statuses) return { valid: false, busy: false };

  let busy = false;
  for (const status of Object.values(statuses)) {
    if (status === null || typeof status !== "object" || Array.isArray(status) || !KNOWN_STATUS_TYPES.has(status.type)) {
      return { valid: false, busy: false };
    }
    if (status.type === "busy") busy = true;
  }
  return { valid: true, busy };
}

export function healthIsCurrent(raw) {
  const health = parseObject(raw);
  return health?.upstreamHealth?.healthy === true;
}

export function healthMatchesVersion(raw, expectedVersion) {
  const health = parseObject(raw);
  return health?.upstreamHealth?.healthy === true && health.upstreamHealth.version === expectedVersion;
}

export function deploymentHealthIsExpected(raw) {
  const health = parseObject(raw);
  return health?.proxy === "opencode-remote" &&
    health.remotePort === 9223 &&
    health.upstream === "http://127.0.0.1:4196" &&
    health.upstreamHealth?.healthy === true;
}

export function fileContentMatches(raw, expectedContent) {
  const response = parseObject(raw);
  return response?.type === "text" && response.content === expectedContent;
}

export function classifyBrewOutdated(exitCode, stdout) {
  if (exitCode === 0 && stdout === "") return "current";
  if (exitCode === 1 && stdout === "opencode") return "outdated";
  return undefined;
}

export function parseMaintenanceId(raw) {
  const response = parseObject(raw);
  const id = response?.id;
  if ((typeof id !== "string" && typeof id !== "number") || !/^[1-9][0-9]*$/.test(String(id))) return undefined;
  return String(id);
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function main([mode, argument]) {
  const raw = readStdin();
  if (mode === "status") {
    const result = inspectSessionStatuses(raw);
    process.exit(result.valid ? (result.busy ? 10 : 0) : 11);
  }
  if (mode === "health-current") process.exit(healthIsCurrent(raw) ? 0 : 1);
  if (mode === "health-version") process.exit(healthMatchesVersion(raw, argument) ? 0 : 1);
  if (mode === "deploy-health") process.exit(deploymentHealthIsExpected(raw) ? 0 : 1);
  if (mode === "file-content") process.exit(fileContentMatches(raw, argument) ? 0 : 1);
  if (mode === "brew-outdated") {
    const result = classifyBrewOutdated(Number(argument), raw);
    process.exit(result === "current" ? 0 : result === "outdated" ? 10 : 11);
  }
  if (mode === "maintenance-id") {
    const id = parseMaintenanceId(raw);
    if (!id) process.exit(1);
    process.stdout.write(id);
    return;
  }
  process.exit(64);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
