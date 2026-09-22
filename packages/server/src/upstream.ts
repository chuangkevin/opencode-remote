import { config } from "./config.js";

// OpenCode 2.x: every API lives under /api, every request needs Basic auth
// (user "opencode", password = OPENCODE_SERVER_PASSWORD), and list/get
// responses are wrapped as { data, cursor?, location? }.

export function upstreamAuthHeaders(): Record<string, string> {
  const token = Buffer.from(`opencode:${config.opencodeServerPassword}`).toString("base64");
  return { authorization: `Basic ${token}` };
}

export function apiUrl(path: string): string {
  return `${config.opencodeUrl}/api${path.startsWith("/") ? path : `/${path}`}`;
}

export async function upstreamFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  for (const [key, value] of Object.entries(upstreamAuthHeaders())) headers.set(key, value);
  return fetch(apiUrl(path), { ...init, headers });
}

export function unwrap<T = unknown>(payload: unknown): T {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && "data" in payload) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

export async function upstreamJson<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await upstreamFetch(path, init);
  if (!res.ok) throw new Error(`OpenCode ${init.method ?? "GET"} ${path} returned ${res.status}`);
  return unwrap<T>(await res.json());
}

// GET /api/info → { version, pid, urls }
export async function upstreamInfo(init?: RequestInit): Promise<{ version: string; pid?: number } | undefined> {
  try {
    const res = await upstreamFetch("/info", init);
    if (res.status !== 200) return undefined;
    const json = (await res.json()) as { version?: string; pid?: number };
    return typeof json.version === "string" ? { version: json.version, pid: json.pid } : undefined;
  } catch {
    return undefined;
  }
}

export async function upstreamHealthy(init?: RequestInit): Promise<boolean> {
  return (await upstreamInfo(init)) !== undefined;
}
