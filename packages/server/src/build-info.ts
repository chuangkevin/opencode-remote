import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BuildInfo = { commit: string; builtAt?: string };

const __filename = fileURLToPath(import.meta.url);
// dist/build-info.js and dist/build-info.json are siblings.
const BUILD_INFO_PATH = join(dirname(__filename), "build-info.json");

export function readBuildInfo(): BuildInfo {
  try {
    const raw = JSON.parse(readFileSync(BUILD_INFO_PATH, "utf8")) as Record<string, unknown>;
    if (typeof raw?.commit === "string" && raw.commit.length > 0) {
      const info: BuildInfo = { commit: raw.commit };
      if (typeof raw.builtAt === "string") info.builtAt = raw.builtAt;
      return info;
    }
  } catch {
    // missing or unreadable — fall through to unknown
  }
  return { commit: "unknown" };
}
