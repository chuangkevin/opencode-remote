import http from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as appConfig } from "../config.js";
import { renderCompactShell } from "./shell.js";
import { ensureSessionTrust } from "./trust.js";

const __filename = fileURLToPath(import.meta.url);
// tsconfig has rootDir=src outDir=dist, so this file ends up at
//   packages/server/dist/compact/handlers.js
// packages/server/static is two levels up from that.
const STATIC_ROOT = join(dirname(__filename), "..", "..", "static");

// Only serve files we explicitly recognize — prevents path traversal.
const ALLOWED: Record<string, string> = {
  "compact.js": "application/javascript; charset=utf-8",
  "compact-model.js": "application/javascript; charset=utf-8",
  "compact.css": "text/css; charset=utf-8",
  "marked.min.js": "application/javascript; charset=utf-8",
};

export function handleCompactStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  // strip leading /c/static/
  const filename = url.pathname.replace(/^\/c\/static\//, "");
  const contentType = ALLOWED[filename];
  if (!contentType) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end("Not found");
    return;
  }
  const path = join(STATIC_ROOT, filename);
  if (!existsSync(path)) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end(`File not found at ${path}`);
    return;
  }
  const body = readFileSync(path);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const SESSION_PATH_RE = /^\/c\/session\/(ses_[A-Za-z0-9]+)\/?$/;

export function matchCompactSessionPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const m = SESSION_PATH_RE.exec(path);
  return m ? m[1] : undefined;
}

export function handleCompactSession(sessionID: string, res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-OpenCode-Remote": "compact",
  });
  res.end(renderCompactShell(sessionID, appConfig.opencodeDirectory));
  // Fire-and-forget: PATCH trust ruleset in the background so the user
  // doesn't have to wait. If it fails the user will just see "ask" prompts
  // (the existing behavior before trust mode existed).
  ensureSessionTrust(appConfig.opencodeUrl, sessionID).catch((err) => {
    console.warn(`[opencode-remote] ensureSessionTrust failed for ${sessionID}:`, err);
  });
}

// Server-side provider filter for the compact model picker.
//
// opencode's raw /provider is ~4.2 MB (168 providers / 5,600+ models). Shipping
// that to a phone stalls the picker on download + parse. We fetch it once
// server-side, drop the dead/paid providers, keep only free (cost 0) active
// models, and return a tiny list matching what the desktop actually offers.
//
// Filter standard (mirrors the rest of HomeProject — see homelab-docs
// "OpenCode model-picker filter standard"): exclude providerID opencode-go and
// openai, keep only models with cost.input === 0 && cost.output === 0. Missing
// cost is treated as free so local/custom providers (e.g. local-llm) survive.
const PICKER_EXCLUDE_PROVIDERS = new Set(["opencode-go", "openai"]);

function isFreeModel(m: { cost?: { input?: number; output?: number } }): boolean {
  return (m?.cost?.input ?? 0) === 0 && (m?.cost?.output ?? 0) === 0;
}

export async function handleCompactProviders(res: http.ServerResponse): Promise<void> {
  try {
    const [provResp, cfgResp] = await Promise.all([
      fetch(`${appConfig.opencodeUrl}/provider`),
      fetch(`${appConfig.opencodeUrl}/config`).catch(() => null),
    ]);
    if (!provResp.ok) throw new Error(`upstream /provider ${provResp.status}`);
    const data = (await provResp.json()) as { all?: unknown };
    const all: any[] = Array.isArray(data?.all) ? (data.all as any[]) : Array.isArray(data) ? (data as any) : [];
    // Allowlist = only the providers the desktop config actually defines, plus
    // the built-in free "opencode" (Zen) provider. This keeps the picker to the
    // same short list the desktop shows (e.g. local-llm + opencode) instead of
    // every provider that merely happens to offer a free tier. A provider the
    // user adds to the config later appears automatically (no cache).
    const allow = new Set<string>(["opencode"]);
    if (cfgResp && cfgResp.ok) {
      const cfg = (await cfgResp.json().catch(() => ({}))) as { provider?: Record<string, unknown> };
      for (const id of Object.keys(cfg?.provider ?? {})) allow.add(id);
    }
    const providers = all
      .filter((p: any) => p && allow.has(p.id) && !PICKER_EXCLUDE_PROVIDERS.has(p.id))
      .map((p: any) => ({
        id: p.id,
        name: p.name ?? p.id,
        models: Object.entries(p.models ?? {})
          .map(([key, m]: [string, any]) => ({ ...(m ?? {}), id: m?.id ?? key }))
          .filter((m: any) => (m.status ? m.status === "active" : true) && isFreeModel(m))
          .map((m: any) => ({ id: m.id, variants: m.variants ?? null })),
      }))
      .filter((p: any) => p.models.length > 0);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-OpenCode-Remote": "compact",
    });
    res.end(JSON.stringify(providers));
  } catch (err) {
    console.error("[opencode-remote] /c/providers failed:", err);
    res.writeHead(502, { "Cache-Control": "no-store" });
    res.end("[]");
  }
}

// ── Add provider (compact picker) ───────────────────────────────────────────
// Writes into the GLOBAL opencode config, not the project one. The project
// config (_HomeProject/opencode.json) is regenerated from opencode-remote's
// template by setup-capabilities.ps1, so anything written there is wiped on the
// next setup/restart. The global file is user-owned, survives, is read by the
// desktop in every folder, and is merged in for the remote too — so a provider
// added here shows up on both surfaces.
const GLOBAL_CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.jsonc");
const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readJsonBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > limit) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export async function handleCompactAddProvider(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const fail = (status: number, error: string): void => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: false, error }));
  };
  try {
    const body = await readJsonBody(req);
    const id = String(body?.id ?? "").trim();
    const name = String(body?.name ?? "").trim() || id;
    const baseURL = String(body?.baseURL ?? "").trim();
    const modelID = String(body?.modelID ?? "").trim();

    if (!PROVIDER_ID_RE.test(id)) return fail(400, "provider id 只能用英數字 . _ -，且不可為空");
    if (!/^https?:\/\//i.test(baseURL)) return fail(400, "baseURL 必須以 http:// 或 https:// 開頭");
    if (!modelID) return fail(400, "model id 不可為空");
    if (!existsSync(GLOBAL_CONFIG_PATH)) return fail(500, `找不到全域設定：${GLOBAL_CONFIG_PATH}`);

    const rawCfg = readFileSync(GLOBAL_CONFIG_PATH, "utf8");
    let cfg: any;
    try {
      cfg = JSON.parse(rawCfg);
    } catch {
      return fail(500, "全域設定不是純 JSON（可能含註解），請手動編輯");
    }
    if (!cfg || typeof cfg !== "object") return fail(500, "全域設定格式不正確");

    cfg.provider = cfg.provider ?? {};
    cfg.provider[id] = {
      name,
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL },
      models: { [modelID]: { name: modelID } },
    };
    writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    // opencode-cli reads providers at startup, so a brand new provider only
    // appears in /provider after the service reloads. Tell the client so it can
    // say so instead of silently showing nothing.
    res.end(JSON.stringify({ ok: true, id, needsRestart: true }));
  } catch (err) {
    console.error("[opencode-remote] /c/providers add failed:", err);
    fail(500, err instanceof Error ? err.message : "新增失敗");
  }
}

export async function handleCompactNewSession(res: http.ServerResponse): Promise<void> {
  try {
    // Do NOT set `title` here — OpenCode's auto-titling (LLM-generated
    // session title) only kicks in when the existing title matches the
    // default pattern "New session - <timestamp>" (see session.ts
    // isDefaultTitle). Setting any custom value disables auto-titling
    // for the lifetime of the session.
    const r = await fetch(`${appConfig.opencodeUrl}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`OpenCode POST /session returned ${r.status}: ${body.slice(0, 200)}`);
    }
    const session = await r.json() as { id?: string };
    if (!session.id) throw new Error("OpenCode response missing session id");
    // Apply trust ruleset before redirecting so the session is ready for
    // fire-and-forget from the very first prompt. Best-effort — if it
    // fails, the next compact-session load will retry.
    try {
      await ensureSessionTrust(appConfig.opencodeUrl, session.id);
    } catch (err) {
      console.warn(`[opencode-remote] ensureSessionTrust on new session ${session.id} failed:`, err);
    }
    res.writeHead(303, {
      Location: `/c/session/${session.id}`,
      "Cache-Control": "no-store",
    });
    res.end();
  } catch (err) {
    console.error("[opencode-remote] /c/new-session failed:", err);
    res.writeHead(502, { "Cache-Control": "no-store" });
    res.end("Failed to create session");
  }
}
