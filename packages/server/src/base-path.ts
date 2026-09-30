import type http from "node:http";

export const FORWARDED_PREFIXES = Object.freeze({
  sara: "/sara",
  l390: "/l390",
  home: "/home",
} as const);

export type Machine = keyof typeof FORWARDED_PREFIXES;

const MACHINE_ORIGINS: Record<Machine, string> = Object.freeze({
  sara: "https://opencode-sara.sisihome.org",
  l390: "https://opencode-l390.sisihome.org",
  home: "https://opencode.sisihome.org",
});

export function requestBasePath(req: Pick<http.IncomingMessage, "headers">): string {
  const value = req.headers?.["x-forwarded-prefix"];
  const prefix = Array.isArray(value) ? value[0] : value;
  return prefix && Object.values(FORWARDED_PREFIXES).includes(prefix as never) ? prefix : "";
}

export function machineForBasePath(basePath: string): Machine | undefined {
  for (const [machine, prefix] of Object.entries(FORWARDED_PREFIXES)) {
    if (prefix === basePath) return machine as Machine;
  }
  return undefined;
}

export function prefixPath(basePath: string, path: string): string {
  if (!basePath || !path.startsWith("/")) return path;
  return `${basePath}${path}`;
}

export function machineOrigin(basePath: string, fallback: string | undefined): string | undefined {
  const machine = machineForBasePath(basePath);
  return machine ? MACHINE_ORIGINS[machine] : fallback;
}

export function machineStorageSuffix(basePath: string): string {
  const machine = machineForBasePath(basePath);
  return machine ? `:${machine}` : "";
}

export function cookieName(basePath: string, name: string): string {
  const machine = machineForBasePath(basePath);
  return machine ? `${name}_${machine}` : name;
}
