import { readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

export const GLOBAL_CONFIG_PATH = join(osHomedir(), ".config", "opencode", "opencode.jsonc");

export type KeyDriftDeps = {
  readFile: (path: string) => string;
  env: Record<string, string | undefined>;
  homedir: string;
};

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      if (i < text.length) output += text[i];
      continue;
    }

    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      output += char;
      continue;
    }

    if (char === ",") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }

    output += char;
  }

  return output;
}

function parseJsonc(text: string): unknown {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function expandHome(path: string, homedir: string): string {
  if (path === "~") return homedir;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return join(homedir, path.slice(2));
  }
  return path;
}

export function resolveConfigValue(raw: string, deps: KeyDriftDeps): string | undefined {
  const fileMatch = /^\{file:(.*)\}$/.exec(raw);
  if (fileMatch) {
    try {
      return deps.readFile(expandHome(fileMatch[1], deps.homedir)).replace(/[\r\n]+$/g, "");
    } catch {
      return undefined;
    }
  }

  const envMatch = /^\{env:([^}]+)\}$/.exec(raw);
  if (envMatch) return deps.env[envMatch[1]];

  return raw;
}

export function expectedProviderKeys(configText: string, deps: KeyDriftDeps): Map<string, string> {
  let config: unknown;
  try {
    config = parseJsonc(configText);
  } catch {
    return new Map();
  }

  if (!isRecord(config) || !isRecord(config.provider)) return new Map();

  const keys = new Map<string, string>();
  for (const [id, provider] of Object.entries(config.provider)) {
    if (!isRecord(provider) || !isRecord(provider.options)) continue;
    const rawApiKey = provider.options.apiKey;
    if (typeof rawApiKey !== "string") continue;
    const resolved = resolveConfigValue(rawApiKey, deps);
    if (resolved !== undefined) keys.set(id, resolved);
  }
  return keys;
}

export function loadedProviderKeys(upstreamConfig: unknown): Map<string, string> {
  if (!isRecord(upstreamConfig) || !isRecord(upstreamConfig.provider)) return new Map();

  const keys = new Map<string, string>();
  for (const [id, provider] of Object.entries(upstreamConfig.provider)) {
    if (!isRecord(provider) || !isRecord(provider.options)) continue;
    const apiKey = provider.options.apiKey;
    if (typeof apiKey === "string") keys.set(id, apiKey);
  }
  return keys;
}

export function detectKeyDrift(expected: Map<string, string>, loaded: Map<string, string>): string[] {
  return [...expected.entries()]
    .filter(([id, expectedKey]) => loaded.has(id) && loaded.get(id) !== expectedKey)
    .map(([id]) => id)
    .sort();
}

export const nodeKeyDriftDeps: KeyDriftDeps = {
  readFile: (path) => readFileSync(path, "utf8"),
  env: process.env,
  homedir: osHomedir(),
};
