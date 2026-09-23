import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.OPENCODE_REMOTE_BUILD_INFO_OUT ?? resolve(here, "../dist/build-info.json");

function gitShortHead() {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!commit) return undefined;
    let dirty = false;
    try {
      // Untracked files (local .env backups, stray scripts) do not affect
      // the built output, so only tracked modifications count as dirty.
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      dirty = status.length > 0;
    } catch {
      dirty = false;
    }
    return dirty ? `${commit}-dirty` : commit;
  } catch {
    return undefined;
  }
}

const commit = gitShortHead() ?? process.env.OPENCODE_REMOTE_BUILD_COMMIT ?? "unknown";
const payload = { commit, builtAt: new Date().toISOString() };
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`build-info: ${payload.commit} -> ${out}`);
