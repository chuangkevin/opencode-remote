import http from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config as appConfig } from "../config.js";
import { renderCompactShell } from "./shell.js";
import { ensureSessionTrust } from "./trust.js";
import { LatestUserModelBudgetError, findLatestUserModel } from "./model.js";
import { upstreamAuthHeaders, upstreamJson } from "../upstream.js";
import { sendHtml } from "../html-response.js";

// Static assets (caching, ETag, gzip/brotli) live in static-assets.js;
// re-exported here so existing import sites keep working.
export { getStaticAsset, handleCompactStatic, staticAssetUrl } from "./static-assets.js";

const SESSION_PATH_RE = /^\/c\/session\/(ses_[A-Za-z0-9]+)\/?$/;
const LATEST_USER_MODEL_PATH_RE = /^\/c\/session\/(ses_[A-Za-z0-9]+)\/latest-user-model\/?$/;
const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

export function matchCompactSessionPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const m = SESSION_PATH_RE.exec(path);
  return m ? m[1] : undefined;
}

export function matchLatestUserModelPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const pathname = new URL(path, "http://localhost").pathname;
  const match = LATEST_USER_MODEL_PATH_RE.exec(pathname);
  return match ? match[1] : undefined;
}

export async function handleLatestUserModel(
  sessionID: string,
  res: http.ServerResponse,
  timeoutMs = 10_000,
): Promise<void> {
  if (!SESSION_ID_RE.test(sessionID)) {
    res.writeHead(400, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: "invalid session id" }));
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const selection = await findLatestUserModel(appConfig.opencodeUrl, sessionID, {
      signal: controller.signal,
      headers: upstreamAuthHeaders(),
    });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-OpenCode-Remote": "compact",
    });
    res.end(JSON.stringify(selection));
  } catch (err) {
    const timedOut = controller.signal.aborted || err instanceof LatestUserModelBudgetError;
    console.error(`[opencode-remote] latest user model failed for ${sessionID}:`, err);
    res.writeHead(timedOut ? 504 : 502, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ error: timedOut ? "model history scan timed out" : "model history unavailable" }));
  } finally {
    clearTimeout(timeout);
  }
}

export function handleCompactSession(req: http.IncomingMessage, sessionID: string, res: http.ServerResponse): void {
  sendHtml(req, res, renderCompactShell(sessionID, appConfig.opencodeDirectory), {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-OpenCode-Remote": "compact",
  });
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
export async function handleCompactProviders(res: http.ServerResponse): Promise<void> {
  try {
    // 2026-09-21 Kevin：「我不想要每次 remote 跟 desktop 都不同步」。
    // compact 的選模型清單不再自己訂規則（allowlist／免費過濾／排除清單全部拿掉），
    // 直接照 OpenCode /provider 的 connected 清單列，跟 desktop、原生頁看到的一模一樣。
    // 要少一個 provider，就在 OpenCode 那邊登出或從 opencode.jsonc 拿掉，三邊一起變。
    // 2.x: GET /api/model?location[directory]=… lists every usable model flat
    // ({ id, providerID, name, variants? }); group by provider for the picker.
    const directory = encodeURIComponent(appConfig.opencodeDirectory);
    const models = await upstreamJson<any[]>(`/model?location[directory]=${directory}`);
    type PickerModel = { id: string; name: string; variants: string[] | null };
    type PickerProvider = { id: string; name: string; models: PickerModel[] };
    const byProvider = new Map<string, PickerProvider>();
    for (const m of Array.isArray(models) ? models : []) {
      if (!m?.providerID || !m?.id) continue;
      const entry: PickerProvider = byProvider.get(m.providerID) ?? { id: m.providerID, name: m.providerID, models: [] };
      // variants: [{ id: "low", settings }] (2.x) or { low: {...} } — keep the names only.
      const variants: string[] | null = Array.isArray(m.variants)
        ? m.variants.map((v: any) => (typeof v === "string" ? v : v?.id)).filter((v: unknown): v is string => typeof v === "string")
        : m.variants && typeof m.variants === "object" ? Object.keys(m.variants) : null;
      entry.models.push({ id: m.modelID ?? m.id, name: m.name ?? m.id, variants: variants && variants.length ? variants : null });
      byProvider.set(m.providerID, entry);
    }
    const providers = [...byProvider.values()].filter((p) => p.models.length > 0);
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
    const session = await upstreamJson<{ id?: string }>("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: appConfig.opencodeDirectory } }),
    });
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
