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

// OpenCode 2.x GET /api/fs/read/<path> answers with the raw file body; the 1.x
// { type: "text", content } shape is still accepted for older probes.
export function fileContentMatches(raw, expectedContent) {
  if (raw.trim() === expectedContent) return true;
  const response = parseObject(raw);
  return response?.type === "text" && response.content === expectedContent;
}

// Desktop-bundled CLI versions live in
//   ~/Library/Application Support/ai.opencode.desktop/cli/<version>/opencode-cli
// stdin: newline-separated directory names. Prints the newest semver that is
// strictly newer than `current`; exits 0 = update available, 1 = current is
// newest, 11 = nothing parseable.
export function newestDesktopCliVersion(raw, current) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
    return m ? m.slice(1, 4).map(Number) : undefined;
  };
  const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const versions = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => parse(line));
  if (versions.length === 0) return { status: "invalid" };
  const newest = versions.reduce((best, v) => (cmp(parse(v), parse(best)) > 0 ? v : best));
  const cur = parse(current);
  if (cur && cmp(parse(newest), cur) <= 0) return { status: "current", newest };
  return { status: "outdated", newest };
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
  if (mode === "desktop-cli-newest") {
    const result = newestDesktopCliVersion(raw, argument);
    if (result.status === "invalid") process.exit(11);
    process.stdout.write(result.newest);
    process.exit(result.status === "outdated" ? 0 : 1);
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
