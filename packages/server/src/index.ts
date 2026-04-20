import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import type { JobOwnershipError } from "./db/index.js";
import type { PermissionReplyChoice } from "./db/index.js";
import { AppDatabase } from "./db/index.js";
import { EventHub } from "./lib/event-hub.js";

const db = new AppDatabase(config.databasePath);
const eventHub = new EventHub();
const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);
const webDistPath = path.resolve(currentDir, "../../web/dist");
const webIndexPath = path.join(webDistPath, "index.html");
const hasBuiltWeb = fs.existsSync(webIndexPath);
const defaults = {
  language: { locale: "zht" },
  server: {
    list: [],
    projects: {
      local: [{ worktree: config.dispatchDirectory, expanded: true }],
    },
    lastProject: {
      local: config.dispatchDirectory,
    },
  },
  settings: {
    general: {
      autoSave: true,
      releaseNotes: true,
      followup: "steer",
      showReasoningSummaries: true,
      shellToolPartsExpanded: true,
      editToolPartsExpanded: true,
    },
    updates: { startup: true },
    appearance: { fontSize: 14, mono: "", sans: "" },
    keybinds: {},
    permissions: { autoApprove: false },
    notifications: { agent: true, permissions: true, errors: false },
    sounds: {
      agentEnabled: true,
      agent: "staplebops-01",
      permissionsEnabled: true,
      permissions: "staplebops-02",
      errorsEnabled: true,
      errors: "nope-03",
    },
  },
  theme: "oc-2",
};

const app = Fastify({
  logger: true,
});

await app.register(cors, {
  origin: true,
});

type NativeSession = {
  id: string;
  title: string;
  directory: string;
  permission?: Array<{
    permission: string;
    pattern: string;
    action: "allow" | "deny" | "ask";
  }> | null;
  time?: {
    updated?: number;
  };
};

type NativeProvider = {
  id: string;
  name: string;
  models: Record<
    string,
    {
      id: string;
      name: string;
      variants?: Record<string, Record<string, unknown>>;
    }
  >;
};

type NativeProviderList = {
  all: NativeProvider[];
  default: Record<string, string>;
  connected: string[];
};

type DispatchSettings = {
  providerId: string | null;
  modelId: string | null;
  variant: string | null;
  permissionMode: "ask" | "allow-all";
  theme: "dark" | "light";
};

type DispatchStateResponse = {
  settings: DispatchSettings;
  thread: Awaited<ReturnType<typeof buildThreadDetail>>;
  providers: Array<{
    id: string;
    name: string;
    connected: boolean;
    defaultModelId: string | null;
    models: Array<{
      id: string;
      name: string;
      variants: string[];
    }>;
  }>;
  native: {
    url: string;
  };
};

type ManagerSession = {
  id: string;
  title: string;
  directory: string;
  updatedAt: number | null;
  archivedAt: number | null;
  url: string;
};

type ManagerStateResponse = {
  native: {
    url: string;
  };
  directory: string;
  activeSessionId: string | null;
  sessions: ManagerSession[];
};

type NativeProject = {
  id: string;
  worktree: string;
  time?: {
    created?: number;
    updated?: number;
  };
  sandboxes?: string[];
};

const dispatchProjectName = "Dispatch";
const dispatchSettingsPath = path.resolve(path.dirname(path.resolve(process.cwd(), config.databasePath)), "dispatch-settings.json");
const activeSessionPath = path.resolve(path.dirname(path.resolve(process.cwd(), config.databasePath)), "active-session.json");

const buildNativeAuthHeader = () => {
  if (!config.nativeOpencodePassword) {
    return null;
  }

  const auth = Buffer.from(`${config.nativeOpencodeUsername}:${config.nativeOpencodePassword}`).toString("base64");
  return `Basic ${auth}`;
};

const encodeDirectorySlug = (dir: string) => Buffer.from(dir, "utf8").toString("base64url");

const fetchNative = async (pathname: string, init: RequestInit = {}) => {
  const auth = buildNativeAuthHeader();
  const response = await fetch(`${config.nativeOpencodeUrl}${pathname}`, {
    ...init,
    headers: {
      ...(auth ? { Authorization: auth } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Native OpenCode request failed (${response.status}): ${body || response.statusText}`);
  }

  return response;
};

const fetchNativeJson = async <T,>(pathname: string, init: RequestInit = {}) => {
  const response = await fetchNative(pathname, init);
  return (await response.json()) as T;
};

const defaultDispatchSettings = (): DispatchSettings => ({
  providerId: null,
  modelId: null,
  variant: null,
  permissionMode: "ask",
  theme: "dark",
});

const readDispatchSettings = (): DispatchSettings => {
  if (!fs.existsSync(dispatchSettingsPath)) {
    return defaultDispatchSettings();
  }

  try {
    const raw = JSON.parse(fs.readFileSync(dispatchSettingsPath, "utf8")) as Partial<DispatchSettings>;
    return {
      providerId: typeof raw.providerId === "string" ? raw.providerId : null,
      modelId: typeof raw.modelId === "string" ? raw.modelId : null,
      variant: typeof raw.variant === "string" ? raw.variant : null,
      permissionMode: raw.permissionMode === "allow-all" ? "allow-all" : "ask",
      theme: raw.theme === "light" ? "light" : "dark",
    };
  } catch {
    return defaultDispatchSettings();
  }
};

const writeDispatchSettings = (settings: DispatchSettings) => {
  fs.mkdirSync(path.dirname(dispatchSettingsPath), { recursive: true });
  fs.writeFileSync(dispatchSettingsPath, JSON.stringify(settings, null, 2));
};

const readActiveSessionId = () => {
  if (!fs.existsSync(activeSessionPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(activeSessionPath, "utf8")) as { sessionId?: string | null };
    return typeof raw.sessionId === "string" && raw.sessionId ? raw.sessionId : null;
  } catch {
    return null;
  }
};

const writeActiveSessionId = (sessionId: string | null) => {
  fs.mkdirSync(path.dirname(activeSessionPath), { recursive: true });
  fs.writeFileSync(activeSessionPath, JSON.stringify({ sessionId }, null, 2));
};

const fetchNativeProviders = async () => fetchNativeJson<NativeProviderList>("/provider");

const chooseDefaultVariant = (variants: string[]) => {
  if (variants.includes("xhigh")) return "xhigh";
  if (variants.includes("high")) return "high";
  return null;
};

const sanitizeDispatchSettings = (input: Partial<DispatchSettings>, providers: NativeProviderList): DispatchSettings => {
  const allProviders = providers.all;
  const connectedProviderIds = new Set(providers.connected);
  const connectedProviders = allProviders.filter((provider) => connectedProviderIds.has(provider.id));
  const firstProvider = connectedProviders[0] ?? allProviders[0] ?? null;

  const provider =
    (input.providerId ? allProviders.find((item) => item.id === input.providerId) : undefined) ?? firstProvider;

  const providerId = provider?.id ?? null;
  const models = provider ? Object.values(provider.models) : [];
  const requestedModel = input.modelId ? models.find((item) => item.id === input.modelId) : undefined;
  const defaultModelId = providerId ? providers.default[providerId] : undefined;
  const model = requestedModel ?? models.find((item) => item.id === defaultModelId) ?? models[0] ?? null;
  const modelId = model?.id ?? null;
  const variants = model?.variants ? Object.keys(model.variants).filter((variant) => variant !== "default") : [];
  const variant = input.variant && variants.includes(input.variant) ? input.variant : chooseDefaultVariant(variants);

  return {
    providerId,
    modelId,
    variant,
    permissionMode: input.permissionMode === "allow-all" ? "allow-all" : "ask",
    theme: input.theme === "light" ? "light" : "dark",
  };
};

const listDispatchThreads = () => {
  const project = db.listProjects().find((item) => item.name === dispatchProjectName);
  if (!project) {
    return { project: null, threads: [] as ReturnType<typeof db.listThreads> };
  }

  return {
    project,
    threads: db.listThreads(project.id),
  };
};

const ensureDispatchThread = () => {
  let { project, threads } = listDispatchThreads();

  if (!project) {
    project = db.createProject(dispatchProjectName);
    threads = [];
  }

  let thread = threads.find((item) => item.title === config.dispatchTitle) ?? threads[0] ?? null;
  if (!thread) {
    thread = db.createThread(project.id, config.dispatchTitle);
    const createdEvent = db.appendThreadEvent(thread.id, "thread_created", {
      title: thread.title,
      projectName: project.name,
    });
    eventHub.publish(thread.id, formatSseEvent(createdEvent));
  }

  return { project, thread };
};

const buildThreadDetail = async (threadId: string) => {
  const thread = db.getThread(threadId);
  if (!thread) {
    throw new Error("找不到 Dispatch thread");
  }

  return {
    thread,
    project: db.getProject(thread.projectId),
    jobs: db.listJobs(thread.id),
    events: db.listThreadEvents(thread.id),
    permissionRequests: db.listPermissionRequests(thread.id),
  };
};

const listDispatchSessions = async () => {
  const query = new URLSearchParams({
    directory: config.dispatchDirectory,
  });
  const response = await fetchNative(`/session?${query.toString()}`);
  return (await response.json()) as NativeSession[];
};

const createDispatchSession = async () => {
  const response = await fetchNative("/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-directory": config.dispatchDirectory,
    },
    body: JSON.stringify({
      title: config.dispatchTitle,
    }),
  });

  return (await response.json()) as NativeSession;
};

const ensureDispatchSession = async () => {
  const sessions = await listDispatchSessions();
  const matching = sessions
    .filter((session) => session.title === config.dispatchTitle && session.directory === config.dispatchDirectory)
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));

  if (matching[0]) {
    return matching[0];
  }

  return createDispatchSession();
};

const buildNativeDispatchUrl = (host: string, sessionId: string) => {
  const base = new URL(`http://${host}`);
  base.pathname = `/${encodeDirectorySlug(config.dispatchDirectory)}/session/${sessionId}`;
  base.search = "";
  base.hash = "";
  return base.toString();
};

const buildNativeSessionUrl = (host: string, dir: string, sessionId: string) => {
  const base = new URL(`http://${host}`);
  base.pathname = `/${encodeDirectorySlug(dir)}/session/${sessionId}`;
  base.search = "";
  base.hash = "";
  return base.toString();
};

const injectDefaults = (html: string) => {
  const page = {
    lastProjectSession: {},
    workspaceOrder: {},
    workspaceName: {},
    workspaceBranchName: {},
    workspaceExpanded: {},
    gettingStartedDismissed: false,
    lastSession: {},
  };
  const script = `<script>(function(){try{localStorage.setItem('opencode.global.dat:language', ${JSON.stringify(JSON.stringify(defaults.language))});localStorage.setItem('opencode.global.dat:server', ${JSON.stringify(JSON.stringify(defaults.server))});localStorage.setItem('opencode.global.dat:layout.page', ${JSON.stringify(JSON.stringify(page))});localStorage.setItem('opencode.global.dat:settings.v3', ${JSON.stringify(JSON.stringify(defaults.settings))});localStorage.setItem('opencode-theme-id', ${JSON.stringify(defaults.theme)});document.cookie='oc_locale=zht; Path=/; Max-Age=31536000; SameSite=Lax';document.documentElement.setAttribute('data-theme', ${JSON.stringify(defaults.theme)});}catch(e){console.error(e);}})();</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`);
  }
  return `${script}${html}`;
};

const currentProject = async () => {
  const list = await fetchNativeJson<NativeProject[]>(`/project`);
  const match = list.find((item) => item.worktree === config.dispatchDirectory);
  if (match) return match;

  const now = Date.now();
  return {
    id: "global",
    worktree: config.dispatchDirectory,
    time: { created: now, updated: now },
    sandboxes: [],
  } satisfies NativeProject;
};

const proxyNative = async (request: Parameters<typeof app.get>[1] extends never ? never : any, reply: Parameters<typeof app.get>[1] extends never ? never : any) => {
  if (request.method === "GET" && request.raw.url?.startsWith("/project/current")) {
    const url = new URL(request.raw.url, "http://localhost");
    const dir = url.searchParams.get("directory");
    if (dir === config.dispatchDirectory) {
      return reply.send(await currentProject());
    }
  }

  const url = new URL(request.raw.url || "/", config.nativeOpencodeUrl);
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (!value) continue;
    if (key === "host") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }
    if (typeof value !== "string") continue;
    headers.set(key, value);
  }

  const method = request.method;
  const body = method === "GET" || method === "HEAD" ? undefined : request.raw;
  const native = await fetch(url, {
    method,
    headers,
    body,
    duplex: body ? "half" : undefined,
  } as RequestInit);

  const type = native.headers.get("content-type") ?? "";
  const status = native.status;

  if (type.includes("text/html")) {
    const text = await native.text();
    return reply.code(status).type(type).send(injectDefaults(text));
  }

  const buf = Buffer.from(await native.arrayBuffer());
  reply.code(status);
  for (const [key, value] of native.headers.entries()) {
    if (key === "content-length") continue;
    reply.header(key, value);
  }
  return reply.send(buf);
};

const listManagerSessions = async (host: string) => {
  const query = new URLSearchParams({
    directory: config.dispatchDirectory,
    roots: "true",
    limit: "100",
  });

  const sessions = await fetchNativeJson<NativeSession[]>(`/session?${query.toString()}`);
  return sessions
    .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
    .map((session) => ({
      id: session.id,
      title: session.title || "Untitled",
      directory: session.directory,
      updatedAt: session.time?.updated ?? null,
      archivedAt: null,
      url: buildNativeSessionUrl(host, session.directory, session.id),
    })) satisfies ManagerSession[];
};

const resolveActiveSession = (sessions: ManagerSession[]) => {
  const saved = readActiveSessionId();
  const active = sessions.find((session) => session.id === saved) ?? null;
  if (!active && saved) {
    writeActiveSessionId(null);
  }
  return active;
};

app.get("/native-dispatch", async (request, reply) => {
  try {
    const session = await ensureDispatchSession();
    const host = request.headers.host ?? `localhost:${config.port}`;
    return reply.redirect(buildNativeDispatchUrl(host, session.id));
  } catch (error) {
    request.log.error({ err: error }, "failed to resolve dispatch session");
    return reply.code(502).send({
      error: error instanceof Error ? error.message : "無法連到原生 OpenCode server",
    });
  }
});

app.get("/health", async () => ({
  ok: true,
  service: "opencode-remote-server",
  time: new Date().toISOString(),
}));

app.get<{ Querystring: { manage?: string } }>("/", async (request, reply) => {
  if (request.query.manage === "1") {
    return reply.redirect("/dispatch");
  }

  return reply.redirect(`/${encodeDirectorySlug(config.dispatchDirectory)}/session`);
});

app.get("/dispatch", async (_request, reply) => {
  if (!hasBuiltWeb) {
    return reply.code(404).send({ error: "Manager UI 尚未建置" });
  }

  return reply.type("text/html; charset=utf-8").send(fs.readFileSync(webIndexPath, "utf8"));
});

app.get("/api/manager/state", async (request, reply) => {
  try {
    const host = request.headers.host ?? `localhost:${config.port}`;
    const sessions = await listManagerSessions(host);
    const active = resolveActiveSession(sessions);
    return {
      native: {
        url: new URL(buildNativeSessionUrl(host, config.dispatchDirectory, "tmp")).origin,
      },
      directory: config.dispatchDirectory,
      activeSessionId: active?.id ?? null,
      sessions,
    } satisfies ManagerStateResponse;
  } catch (error) {
    request.log.error({ err: error }, "failed to build manager state");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "無法讀取 session 清單" });
  }
});

app.post<{ Body: { title?: string } }>("/api/manager/sessions", async (request, reply) => {
  try {
    const title = request.body.title?.trim();
    const session = await fetchNativeJson<NativeSession>("/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-opencode-directory": config.dispatchDirectory,
      },
      body: JSON.stringify(title ? { title } : {}),
    });

    const host = request.headers.host ?? `localhost:${config.port}`;
    writeActiveSessionId(session.id);
    return reply.code(201).send({
      session: {
        id: session.id,
        title: session.title || "Untitled",
        directory: session.directory,
        updatedAt: session.time?.updated ?? null,
        archivedAt: null,
        url: buildNativeSessionUrl(host, session.directory, session.id),
      } satisfies ManagerSession,
    });
  } catch (error) {
    request.log.error({ err: error }, "failed to create native session");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "無法建立 session" });
  }
});

app.get<{ Params: { sessionId: string } }>("/open/:sessionId", async (request, reply) => {
  try {
    const session = await fetchNativeJson<NativeSession>(`/session/${encodeURIComponent(request.params.sessionId)}`);
    writeActiveSessionId(session.id);
    const host = request.headers.host ?? `localhost:${config.port}`;
    return reply.redirect(buildNativeSessionUrl(host, session.directory, session.id));
  } catch (error) {
    request.log.error({ err: error }, "failed to open native session");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "無法開啟 session" });
  }
});

app.get("/api/dispatch/state", async (request, reply) => {
  try {
    const { thread } = ensureDispatchThread();
    const providers = await fetchNativeProviders();
    const settings = sanitizeDispatchSettings(readDispatchSettings(), providers);
    writeDispatchSettings(settings);

    return {
      settings,
      thread: await buildThreadDetail(thread.id),
      providers: providers.all.map((provider) => ({
        id: provider.id,
        name: provider.name,
        connected: providers.connected.includes(provider.id),
        defaultModelId: providers.default[provider.id] ?? null,
        models: Object.values(provider.models).map((model) => ({
          id: model.id,
          name: model.name,
          variants: model.variants ? Object.keys(model.variants).filter((variant) => variant !== "default") : [],
        })),
      })),
      native: {
        url: config.nativeOpencodeUrl,
      },
    } satisfies DispatchStateResponse;
  } catch (error) {
    request.log.error({ err: error }, "failed to build dispatch state");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "無法讀取 Dispatch state" });
  }
});

app.put<{ Body: Partial<DispatchSettings> }>("/api/dispatch/settings", async (request, reply) => {
  try {
    const providers = await fetchNativeProviders();
    const settings = sanitizeDispatchSettings(request.body ?? {}, providers);
    writeDispatchSettings(settings);
    return { settings };
  } catch (error) {
    request.log.error({ err: error }, "failed to update dispatch settings");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "無法更新 Dispatch 設定" });
  }
});

app.post<{ Body: { prompt?: string } }>("/api/dispatch/prompt", async (request, reply) => {
  const prompt = request.body.prompt?.trim();
  if (!prompt) {
    return reply.code(400).send({ error: "請輸入 prompt" });
  }

  try {
    const { thread } = ensureDispatchThread();
    const providers = await fetchNativeProviders();
    const settings = sanitizeDispatchSettings(readDispatchSettings(), providers);
    writeDispatchSettings(settings);

    const job = db.createQueuedJob(thread.id, prompt, {
      providerId: settings.providerId,
      modelId: settings.modelId,
      variant: settings.variant,
      permissionMode: settings.permissionMode,
    });
    const userPromptEvent = db.appendThreadEvent(thread.id, "user_prompt", {
      prompt,
      model: settings.providerId && settings.modelId ? `${settings.providerId}/${settings.modelId}` : null,
      variant: settings.variant,
      permissionMode: settings.permissionMode,
    }, job.id);
    const queuedEvent = db.appendThreadEvent(thread.id, "job_queued", { prompt }, job.id);

    eventHub.publish(thread.id, formatSseEvent(userPromptEvent));
    eventHub.publish(thread.id, formatSseEvent(queuedEvent));

    return reply.code(202).send({ job });
  } catch (error) {
    request.log.error({ err: error }, "failed to dispatch prompt");
    return reply.code(502).send({ error: error instanceof Error ? error.message : "無法派發 prompt" });
  }
});

app.post<{ Params: { requestId: string }; Body: { response?: PermissionReplyChoice } }>("/api/dispatch/permissions/:requestId", async (request, reply) => {
  const response = request.body.response;
  if (response !== "once" && response !== "always" && response !== "reject") {
    return reply.code(400).send({ error: "response 必須是 once、always 或 reject" });
  }

  const { thread } = ensureDispatchThread();
  const permission = db.answerPermissionRequest(thread.id, request.params.requestId, response);
  if (!permission) {
    return reply.code(404).send({ error: "找不到 permission request" });
  }

  const event = db.appendThreadEvent(permission.threadId, "permission_answered", {
    requestId: permission.id,
    response,
  }, permission.jobId);
  eventHub.publish(permission.threadId, formatSseEvent(event));

  return { permission };
});

app.post("/api/dispatch/abort", async (_request, reply) => {
  const { thread } = ensureDispatchThread();
  const job = db.listJobs(thread.id).find((item) => item.status === "running" || item.status === "queued");
  if (!job) {
    return reply.code(404).send({ error: "目前沒有可中止的工作" });
  }

  db.requestAbort(job.id);
  const event = db.appendThreadEvent(job.threadId, "abort_requested", { jobId: job.id }, job.id);
  eventHub.publish(job.threadId, formatSseEvent(event));

  return { ok: true, jobId: job.id };
});

app.get("/api/projects", async () => ({
  projects: db.listProjects(),
}));

app.post<{ Body: { name?: string } }>("/api/projects", async (request, reply) => {
  const name = request.body.name?.trim();
  if (!name) {
    return reply.code(400).send({ error: "請輸入專案名稱" });
  }

  const project = db.createProject(name);
  return reply.code(201).send({ project });
});

app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/threads", async (request, reply) => {
  const project = db.getProject(request.params.projectId);
  if (!project) {
    return reply.code(404).send({ error: "找不到專案" });
  }

  return {
    project,
    threads: db.listThreads(project.id),
  };
});

app.post<{ Params: { projectId: string }; Body: { title?: string } }>("/api/projects/:projectId/threads", async (request, reply) => {
  const project = db.getProject(request.params.projectId);
  if (!project) {
    return reply.code(404).send({ error: "找不到專案" });
  }

  const title = request.body.title?.trim() || `Dispatch ${new Date().toLocaleString("zh-TW")}`;
  const thread = db.createThread(project.id, title);
  const createdEvent = db.appendThreadEvent(thread.id, "thread_created", {
    title: thread.title,
    projectName: project.name,
  });

  eventHub.publish(thread.id, formatSseEvent(createdEvent));

  return reply.code(201).send({ thread });
});

app.get<{ Params: { threadId: string } }>("/api/threads/:threadId", async (request, reply) => {
  const thread = db.getThread(request.params.threadId);
  if (!thread) {
    return reply.code(404).send({ error: "找不到 thread" });
  }

  const project = db.getProject(thread.projectId);
  const jobs = db.listJobs(thread.id);
  const events = db.listThreadEvents(thread.id);
  const permissionRequests = db.listPermissionRequests(thread.id);

  return {
    thread,
    project,
    jobs,
    events,
    permissionRequests,
  };
});

app.get<{ Params: { threadId: string }; Querystring: { after?: string } }>("/api/threads/:threadId/stream", async (request, reply) => {
  const thread = db.getThread(request.params.threadId);
  if (!thread) {
    return reply.code(404).send({ error: "找不到 thread" });
  }

  const after = Number(request.query.after ?? 0);
  const existingEvents = db.listThreadEvents(thread.id, Number.isFinite(after) ? after : 0);

  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  reply.raw.flushHeaders();

  const cleanupCallbacks = new Set<() => void>();
  let closed = false;

  const cleanup = () => {
    if (closed) {
      return;
    }

    closed = true;
    for (const callback of cleanupCallbacks) {
      callback();
    }
    cleanupCallbacks.clear();
  };

  const writeSse = (response: ServerResponse, payload: string) => {
    if (closed || response.destroyed || response.writableEnded) {
      return false;
    }

    try {
      response.write(payload);
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  cleanupCallbacks.add(() => {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end();
    }
  });

  writeSse(reply.raw, `event: ready\ndata: ${JSON.stringify({ threadId: thread.id })}\n\n`);
  for (const event of existingEvents) {
    if (!writeSse(reply.raw, formatSseEvent(event))) {
      return reply;
    }
  }

  const unsubscribe = eventHub.subscribe(thread.id, (payload) => {
    writeSse(reply.raw, payload);
  });
  cleanupCallbacks.add(unsubscribe);

  const heartbeat = setInterval(() => {
    writeSse(reply.raw, `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
  }, config.sseHeartbeatMs);
  cleanupCallbacks.add(() => {
    clearInterval(heartbeat);
  });

  request.raw.on("close", cleanup);
  request.raw.on("aborted", cleanup);
  reply.raw.on("close", cleanup);
  reply.raw.on("error", cleanup);

  return reply;
});

app.post<{ Params: { threadId: string }; Body: { prompt?: string } }>("/api/threads/:threadId/dispatch", async (request, reply) => {
  const thread = db.getThread(request.params.threadId);
  if (!thread) {
    return reply.code(404).send({ error: "找不到 thread" });
  }

  const prompt = request.body.prompt?.trim();
  if (!prompt) {
    return reply.code(400).send({ error: "請輸入 prompt" });
  }

  const job = db.createQueuedJob(thread.id, prompt);
  const userPromptEvent = db.appendThreadEvent(thread.id, "user_prompt", { prompt }, job.id);
  const queuedEvent = db.appendThreadEvent(thread.id, "job_queued", { prompt }, job.id);

  eventHub.publish(thread.id, formatSseEvent(userPromptEvent));
  eventHub.publish(thread.id, formatSseEvent(queuedEvent));

  return reply.code(202).send({ job });
});

app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/abort", async (request, reply) => {
  const job = db.getJob(request.params.jobId);
  if (!job) {
    return reply.code(404).send({ error: "找不到 job" });
  }

  db.requestAbort(job.id);
  const event = db.appendThreadEvent(job.threadId, "abort_requested", { jobId: job.id }, job.id);
  eventHub.publish(job.threadId, formatSseEvent(event));

  return { ok: true };
});

app.post<{ Params: { threadId: string; requestId: string }; Body: { response?: PermissionReplyChoice } }>(
  "/api/threads/:threadId/permissions/:requestId",
  async (request, reply) => {
    const response = request.body.response;
    if (response !== "once" && response !== "always" && response !== "reject") {
      return reply.code(400).send({ error: "response 必須是 once、always 或 reject" });
    }

    const permission = db.answerPermissionRequest(request.params.threadId, request.params.requestId, response);
    if (!permission) {
      return reply.code(404).send({ error: "找不到 permission request" });
    }

    const event = db.appendThreadEvent(permission.threadId, "permission_answered", {
      requestId: permission.id,
      response,
    }, permission.jobId);
    eventHub.publish(permission.threadId, formatSseEvent(event));

    return { permission };
  },
);

app.post<{ Body: { endpoint?: string; keys?: { p256dh?: string; auth?: string }; deviceLabel?: string | null } }>(
  "/api/push/subscriptions",
  async (request, reply) => {
    const endpoint = request.body.endpoint?.trim();
    const p256dh = request.body.keys?.p256dh?.trim();
    const auth = request.body.keys?.auth?.trim();

    if (!endpoint || !p256dh || !auth) {
      return reply.code(400).send({ error: "push subscription 欄位不完整" });
    }

    const subscription = db.upsertPushSubscription({
      endpoint,
      p256dh,
      auth,
      deviceLabel: request.body.deviceLabel ?? null,
    });

    return reply.code(201).send({ subscription });
  },
);

app.addHook("onRequest", async (request, reply) => {
  if (!request.url.startsWith("/internal/")) {
    return;
  }

  const providedToken = request.headers["x-runner-token"];
  if (providedToken !== config.runnerSharedToken) {
    return reply.code(401).send({ error: "runner token 無效" });
  }
});

app.post<{ Body: { runnerId?: string; leaseMs?: number } }>("/internal/jobs/claim", async (request) => {
  const runnerId = request.body.runnerId?.trim() || "runner-unknown";
  const leaseMs = Math.max(1000, Number(request.body.leaseMs ?? 15000));
  const job = db.claimNextJob(runnerId, leaseMs);

  if (!job) {
    return { job: null };
  }

  const eventType = job.reclaimed ? "runner_reclaimed" : "runner_claimed";
  const event = db.appendThreadEvent(job.threadId, eventType, { runnerId }, job.id);
  eventHub.publish(job.threadId, formatSseEvent(event));

  return { job };
});

app.post<{ Params: { threadId: string }; Body: { sessionId?: string } }>("/internal/threads/:threadId/session", async (request, reply) => {
  const sessionId = request.body.sessionId?.trim();
  if (!sessionId) {
    return reply.code(400).send({ error: "sessionId 必填" });
  }

  const thread = db.setThreadSession(request.params.threadId, sessionId);
  if (!thread) {
    return reply.code(404).send({ error: "找不到 thread" });
  }

  const event = db.appendThreadEvent(thread.id, "session_mapped", { sessionId });
  eventHub.publish(thread.id, formatSseEvent(event));

  return { thread };
});

app.post<{ Params: { jobId: string }; Body: { runnerId?: string; requestId?: string; payload?: Record<string, unknown> } }>(
  "/internal/jobs/:jobId/permissions",
  async (request, reply) => {
    const runnerId = request.body.runnerId?.trim() || "runner-unknown";
    const requestId = request.body.requestId?.trim();
    if (!requestId) {
      return reply.code(400).send({ error: "requestId 必填" });
    }

    const result = db.upsertPermissionRequest(request.params.jobId, runnerId, {
      requestId,
      payload: request.body.payload ?? {},
    });

    if (hasOwnershipError(result)) {
      return reply.code(mapOwnershipErrorToStatus(result.error)).send({ error: mapOwnershipErrorMessage(result.error) });
    }

    const event = db.appendThreadEvent(result.job.threadId, "permission_requested", {
      requestId: result.permission.id,
      payload: result.permission.payload,
    }, result.job.id);
    eventHub.publish(result.job.threadId, formatSseEvent(event));

    return { permission: result.permission };
  },
);

app.post<{ Params: { jobId: string }; Body: { runnerId?: string; leaseMs?: number } }>("/internal/jobs/:jobId/heartbeat", async (request, reply) => {
  const runnerId = request.body.runnerId?.trim() || "runner-unknown";
  const leaseMs = Math.max(1000, Number(request.body.leaseMs ?? 15000));

  const result = db.heartbeatJob(request.params.jobId, runnerId, leaseMs);
  if (hasOwnershipError(result)) {
    return reply.code(mapOwnershipErrorToStatus(result.error)).send({ error: mapOwnershipErrorMessage(result.error) });
  }

  return { ok: true, abortRequested: result.abortRequested, permissionReplies: result.permissionReplies };
});

app.post<{ Params: { jobId: string; requestId: string }; Body: { runnerId?: string; response?: PermissionReplyChoice | null } }>(
  "/internal/jobs/:jobId/permissions/:requestId/replied",
  async (request, reply) => {
    const runnerId = request.body.runnerId?.trim() || "runner-unknown";
    const result = db.markPermissionRequestReplied(request.params.jobId, runnerId, request.params.requestId);

    if (hasOwnershipError(result)) {
      return reply.code(mapOwnershipErrorToStatus(result.error)).send({ error: mapOwnershipErrorMessage(result.error) });
    }

    const event = db.appendThreadEvent(result.job.threadId, "permission_replied", {
      requestId: result.permission.id,
      response: request.body.response ?? result.permission.response ?? null,
    }, result.job.id);
    eventHub.publish(result.job.threadId, formatSseEvent(event));

    return { permission: result.permission };
  },
);

app.post<{ Params: { jobId: string }; Body: { runnerId?: string; events?: Array<{ type?: string; payload?: Record<string, unknown> }> } }>(
  "/internal/jobs/:jobId/events",
  async (request, reply) => {
    const runnerId = request.body.runnerId?.trim() || "runner-unknown";

    const sanitizedEvents = (request.body.events ?? [])
      .filter((event): event is { type: string; payload: Record<string, unknown> } => Boolean(event.type))
      .map((event) => ({
        type: event.type,
        payload: event.payload ?? {},
      }));

    const result = db.appendJobThreadEvents(request.params.jobId, runnerId, sanitizedEvents);
    if (hasOwnershipError(result)) {
      return reply.code(mapOwnershipErrorToStatus(result.error)).send({ error: mapOwnershipErrorMessage(result.error) });
    }

    for (const event of result.events) {
      eventHub.publish(result.job.threadId, formatSseEvent(event));
    }

    return { events: result.events };
  },
);

app.post<{ Params: { jobId: string }; Body: { runnerId?: string; status?: "completed" | "failed"; error?: string | null } }>(
  "/internal/jobs/:jobId/status",
  async (request, reply) => {
    const status = request.body.status;
    const runnerId = request.body.runnerId?.trim() || "runner-unknown";
    if (status !== "completed" && status !== "failed") {
      return reply.code(400).send({ error: "status 必須是 completed 或 failed" });
    }

    const result = db.updateJobStatus(request.params.jobId, runnerId, status, request.body.error ?? null);
    if (hasOwnershipError(result)) {
      return reply.code(mapOwnershipErrorToStatus(result.error)).send({ error: mapOwnershipErrorMessage(result.error) });
    }

    const eventType = status === "completed" ? "job_completed" : "job_failed";
    const event = db.appendThreadEvent(result.threadId, eventType, { error: request.body.error ?? null }, result.id);
    eventHub.publish(result.threadId, formatSseEvent(event));

    return { job: result };
  },
);

if (hasBuiltWeb) {
  await app.register(fastifyStatic, {
    root: webDistPath,
    prefix: "/dispatch/",
    decorateReply: false,
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (!request.url.startsWith("/api/") && !request.url.startsWith("/internal/") && !request.url.startsWith("/dispatch")) {
      return proxyNative(request, reply);
    }

    return reply.code(404).send({ error: "找不到資源" });
  });
}

const hasOwnershipError = (value: { error: JobOwnershipError } | object): value is { error: JobOwnershipError } => "error" in value;

const mapOwnershipErrorToStatus = (error: JobOwnershipError) => {
  switch (error) {
    case "not_found":
      return 404;
    case "runner_mismatch":
    case "lease_expired":
    case "not_running":
      return 409;
  }
};

const mapOwnershipErrorMessage = (error: JobOwnershipError) => {
  switch (error) {
    case "not_found":
      return "找不到 job";
    case "runner_mismatch":
      return "job 不屬於目前 runner";
    case "lease_expired":
      return "job lease 已過期";
    case "not_running":
      return "job 目前不是 running 狀態";
  }
};

const formatSseEvent = (event: { id: number; threadId: string; jobId: string | null; type: string; payload: Record<string, unknown>; createdAt: string }) => {
  const data = JSON.stringify(event);
  return `id: ${event.id}\nevent: timeline\ndata: ${data}\n\n`;
};

await app.listen({
  port: config.port,
  host: "0.0.0.0",
});
