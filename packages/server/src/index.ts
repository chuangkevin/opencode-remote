import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
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

const app = Fastify({
  logger: true,
});

await app.register(cors, {
  origin: true,
});

app.get("/health", async () => ({
  ok: true,
  service: "opencode-remote-server",
  time: new Date().toISOString(),
}));

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
    prefix: "/",
    decorateReply: false,
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api/") && !request.url.startsWith("/internal/")) {
      return reply.type("text/html; charset=utf-8").send(fs.readFileSync(webIndexPath, "utf8"));
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
