import os from "node:os";

const MIN_POLL_INTERVAL_MS = 250;
const MAX_POLL_INTERVAL_MS = 60_000;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 300_000;
const MIN_STUB_DELAY_MS = 0;
const MAX_STUB_DELAY_MS = 300_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;

type ClaimedJob = {
  id: string;
  threadId: string;
  prompt: string;
  thread: {
    id: string;
    title: string;
    opencodeSessionId: string | null;
  };
};

type ClaimResponse = {
  job: ClaimedJob | null;
};

type PermissionReply = {
  id: string;
  upstreamPermissionId: string;
  response: "once" | "always" | "reject";
};

type HeartbeatResponse = {
  ok: boolean;
  abortRequested: boolean;
  permissionReplies: PermissionReply[];
};

type OpenCodeSession = {
  id: string;
  title: string;
  directory: string;
};

type OpenCodeEvent = {
  type: string;
  properties?: Record<string, unknown>;
};

type HeaderInput = ConstructorParameters<typeof Headers>[0];

type MonitorResult = {
  status: "completed" | "failed";
  error: string | null;
};

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function readClampedEnvNumber(name: string, fallback: number, min: number, max: number) {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return clampNumber(Math.trunc(parsed), min, max);
}

const config = {
  serverUrl: process.env.DISPATCH_SERVER_URL ?? "http://localhost:9223",
  runnerToken: process.env.RUNNER_SHARED_TOKEN ?? "change-this-runner-token",
  pollIntervalMs: readClampedEnvNumber("RUNNER_POLL_INTERVAL_MS", 3000, MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS),
  leaseMs: readClampedEnvNumber("RUNNER_LEASE_MS", 15000, MIN_LEASE_MS, MAX_LEASE_MS),
  executionMode: process.env.RUNNER_EXECUTION_MODE ?? "stub",
  stubDelayMs: readClampedEnvNumber("RUNNER_STUB_DELAY_MS", 1500, MIN_STUB_DELAY_MS, MAX_STUB_DELAY_MS),
  opencodeUrl: process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096",
  opencodePassword: process.env.OPENCODE_SERVER_PASSWORD ?? "",
  opencodeUsername: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
  opencodeDirectory: process.env.OPENCODE_DIRECTORY?.trim() || undefined,
};

const requestTimeoutMs = readClampedEnvNumber(
  "RUNNER_REQUEST_TIMEOUT_MS",
  Math.max(config.leaseMs, 5_000),
  MIN_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
);

const runnerId = `${os.hostname()}-${process.pid}`;

const headers = {
  "content-type": "application/json",
  "x-runner-token": config.runnerToken,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const url = (pathname: string) => `${config.serverUrl}${pathname}`;

function createAbortSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);

  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timeout),
  };
}

async function readResponseDetails(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      return JSON.stringify(await response.json());
    }

    const text = await response.text();
    return text || "<empty body>";
  } catch {
    return "<failed to read response body>";
  }
}

async function readJson<T>(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return null as T;
  }

  return JSON.parse(text) as T;
}

async function fetchInternal(pathname: string, init: RequestInit = {}) {
  const { signal, dispose } = createAbortSignal(requestTimeoutMs);

  try {
    const response = await fetch(url(pathname), {
      ...init,
      headers: {
        ...headers,
        ...(init.headers ?? {}),
      },
      signal,
    });

    if (!response.ok) {
      const details = await readResponseDetails(response);
      throw new Error(`Internal request failed (${init.method ?? "GET"} ${pathname}): ${response.status} ${response.statusText} - ${details}`);
    }

    return response;
  } finally {
    dispose();
  }
}

function buildOpenCodeHeaders(extra?: HeaderInput) {
  const next = new Headers(extra);

  if (config.opencodePassword) {
    const auth = Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64");
    next.set("Authorization", `Basic ${auth}`);
  }

  if (config.opencodeDirectory) {
    next.set("x-opencode-directory", encodeURIComponent(config.opencodeDirectory));
  }

  return next;
}

async function fetchOpenCode(pathname: string, init: RequestInit = {}, timeoutMs = requestTimeoutMs) {
  const controller = timeoutMs > 0 ? createAbortSignal(timeoutMs) : null;

  try {
    const response = await fetch(`${config.opencodeUrl}${pathname}`, {
      ...init,
      headers: buildOpenCodeHeaders(init.headers),
      signal: init.signal ?? controller?.signal,
    });

    if (!response.ok) {
      const details = await readResponseDetails(response);
      throw new Error(`OpenCode request failed (${init.method ?? "GET"} ${pathname}): ${response.status} ${response.statusText} - ${details}`);
    }

    return response;
  } finally {
    controller?.dispose();
  }
}

async function claimJob() {
  const response = await fetchInternal("/internal/jobs/claim", {
    method: "POST",
    body: JSON.stringify({
      runnerId,
      leaseMs: config.leaseMs,
    }),
  });

  const payload = await readJson<ClaimResponse>(response);
  return payload?.job ?? null;
}

async function setThreadSession(threadId: string, sessionId: string) {
  await fetchInternal(`/internal/threads/${threadId}/session`, {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

async function postEvents(jobId: string, events: Array<{ type: string; payload: Record<string, unknown> }>) {
  if (events.length === 0) {
    return;
  }

  await fetchInternal(`/internal/jobs/${jobId}/events`, {
    method: "POST",
    body: JSON.stringify({ runnerId, events }),
  });
}

async function heartbeat(jobId: string) {
  const response = await fetchInternal(`/internal/jobs/${jobId}/heartbeat`, {
    method: "POST",
    body: JSON.stringify({
      runnerId,
      leaseMs: config.leaseMs,
    }),
  });

  return await readJson<HeartbeatResponse>(response);
}

async function updateStatus(jobId: string, status: "completed" | "failed", error: string | null = null) {
  await fetchInternal(`/internal/jobs/${jobId}/status`, {
    method: "POST",
    body: JSON.stringify({ runnerId, status, error }),
  });
}

async function postPermissionRequest(jobId: string, requestId: string, payload: Record<string, unknown>) {
  await fetchInternal(`/internal/jobs/${jobId}/permissions`, {
    method: "POST",
    body: JSON.stringify({ runnerId, requestId, payload }),
  });
}

async function markPermissionReplied(jobId: string, requestId: string, response: PermissionReply["response"] | null) {
  await fetchInternal(`/internal/jobs/${jobId}/permissions/${encodeURIComponent(requestId)}/replied`, {
    method: "POST",
    body: JSON.stringify({ runnerId, response }),
  });
}

async function createOpenCodeSession(title: string) {
  const response = await fetchOpenCode("/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ title }),
  });

  return await readJson<OpenCodeSession>(response);
}

async function promptOpenCodeSession(sessionId: string, prompt: string) {
  await fetchOpenCode(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      parts: [
        {
          type: "text",
          text: prompt,
        },
      ],
    }),
  });
}

async function abortOpenCodeSession(sessionId: string) {
  await fetchOpenCode(`/session/${encodeURIComponent(sessionId)}/abort`, {
    method: "POST",
  });
}

async function replyOpenCodePermission(
  sessionId: string,
  requestId: string,
  response: PermissionReply["response"],
) {
  await fetchOpenCode(`/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ response }),
  });
}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function getSessionId(event: OpenCodeEvent) {
  const props = asRecord(event.properties);
  if (!props) {
    return undefined;
  }

  const direct = asString(props.sessionID);
  if (direct) {
    return direct;
  }

  const part = asRecord(props.part);
  if (part) {
    const partSessionId = asString(part.sessionID);
    if (partSessionId) {
      return partSessionId;
    }
  }

  const info = asRecord(props.info);
  if (info) {
    return asString(info.sessionID);
  }

  return undefined;
}

function getSessionError(event: OpenCodeEvent) {
  const props = asRecord(event.properties);
  const error = asRecord(props?.error);
  const data = asRecord(error?.data);
  return asString(data?.message) ?? asString(error?.name) ?? "OpenCode session failed";
}

function mapPermissionPayload(event: OpenCodeEvent) {
  const props = asRecord(event.properties) ?? {};
  const patterns = asStringArray(props.patterns);
  const pattern = props.pattern;

  return {
    requestId: asString(props.id) ?? "",
    permission: asString(props.permission) ?? asString(props.type) ?? "unknown",
    title: asString(props.title) ?? "Permission requested",
    patterns: patterns.length > 0 ? patterns : typeof pattern === "string" ? [pattern] : asStringArray(pattern),
    metadata: asRecord(props.metadata) ?? {},
    always: asStringArray(props.always),
    tool: asRecord(props.tool),
  };
}

function mapTimelineEvents(event: OpenCodeEvent) {
  const props = asRecord(event.properties);
  if (!props) {
    return [] as Array<{ type: string; payload: Record<string, unknown> }>;
  }

  if (event.type === "message.part.updated") {
    const part = asRecord(props.part);
    if (!part) {
      return [];
    }

    if (part.type === "text" && asString(part.text) && asRecord(part.time)?.end) {
      return [
        {
          type: "assistant_message",
          payload: {
            text: asString(part.text) ?? "",
          },
        },
      ];
    }

    if (part.type === "reasoning" && asString(part.text) && asRecord(part.time)?.end) {
      return [
        {
          type: "assistant_reasoning",
          payload: {
            text: asString(part.text) ?? "",
          },
        },
      ];
    }

    if (part.type === "tool") {
      const state = asRecord(part.state);
      const tool = asString(part.tool) ?? "tool";
      const status = asString(state?.status) ?? "unknown";

      if (status === "completed") {
        return [
          {
            type: "tool_completed",
            payload: {
              tool,
              title: asString(state?.title) ?? tool,
              output: asString(state?.output) ?? "",
            },
          },
        ];
      }

      if (status === "error") {
        return [
          {
            type: "tool_error",
            payload: {
              tool,
              error: asString(state?.error) ?? "Tool failed",
            },
          },
        ];
      }

      return [];
    }

    if (part.type === "patch") {
      return [
        {
          type: "session_patch",
          payload: {
            files: Array.isArray(part.files) ? part.files : [],
          },
        },
      ];
    }

    return [];
  }

  if (event.type === "session.diff") {
    return [
      {
        type: "session_diff",
        payload: {
          diff: Array.isArray(props.diff) ? props.diff : [],
        },
      },
    ];
  }

  if (event.type === "file.edited") {
    return [
      {
        type: "file_edited",
        payload: {
          file: asString(props.file) ?? "",
        },
      },
    ];
  }

  if (event.type === "session.status") {
    return [
      {
        type: "session_status",
        payload: {
          status: props.status ?? null,
        },
      },
    ];
  }

  return [];
}

async function failClaimedJob(jobId: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);

  try {
    await postEvents(jobId, [
      {
        type: "runner_error",
        payload: {
          message,
        },
      },
    ]);
  } catch (postError) {
    console.error(`[runner] failed to post error event for job ${jobId}`, postError);
  }

  try {
    await updateStatus(jobId, "failed", message);
  } catch (statusError) {
    console.error(`[runner] failed to mark job ${jobId} as failed`, statusError);
  }
}

async function executeStubJob(job: ClaimedJob) {
  const sessionId = job.thread.opencodeSessionId ?? `stub-ses-${job.thread.id}`;
  await setThreadSession(job.thread.id, sessionId);

  await postEvents(job.id, [
    {
      type: "runner_note",
      payload: {
        runnerId,
        mode: config.executionMode,
      },
    },
    {
      type: "assistant_message",
      payload: {
        text: `Stub runner 已接手工作。這是第一版端到端骨架，下一步會把這段執行器換成真正的 OpenCode bridge。\n\n收到的 prompt:\n${job.prompt}`,
      },
    },
  ]);

  const startedAt = Date.now();
  while (Date.now() - startedAt < config.stubDelayMs) {
    const heartbeatResult = await heartbeat(job.id);
    if (heartbeatResult?.abortRequested) {
      await postEvents(job.id, [
        {
          type: "runner_abort",
          payload: {
            message: "Server requested job abort during stub execution.",
          },
        },
      ]);
      await updateStatus(job.id, "failed", "Execution aborted by server request.");
      return;
    }

    await sleep(Math.min(config.leaseMs / 2, 1000));
  }

  await updateStatus(job.id, "completed");
}

function createOpenCodeMonitor(job: ClaimedJob, sessionId: string) {
  const controller = new AbortController();
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  let doneResolve!: (result: MonitorResult) => void;
  let doneReject!: (error: unknown) => void;
  let settled = false;
  let heartbeatRunning = false;
  let abortForwarded = false;
  const handledReplies = new Set<string>();

  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const done = new Promise<MonitorResult>((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });

  const finish = (result: MonitorResult) => {
    if (settled) {
      return;
    }

    settled = true;
    controller.abort();
    doneResolve(result);
  };

  const fail = (error: unknown) => {
    if (settled) {
      return;
    }

    settled = true;
    controller.abort();
    doneReject(error);
  };

  const tick = async () => {
    if (settled || heartbeatRunning) {
      return;
    }

    heartbeatRunning = true;
    try {
      const state = await heartbeat(job.id);
      if (!state) {
        return;
      }

      if (state.abortRequested && !abortForwarded) {
        abortForwarded = true;
        await postEvents(job.id, [
          {
            type: "runner_abort",
            payload: {
              message: "Server requested job abort.",
            },
          },
        ]);
        await abortOpenCodeSession(sessionId);
      }

      for (const reply of state.permissionReplies ?? []) {
        if (handledReplies.has(reply.id)) {
          continue;
        }

        handledReplies.add(reply.id);
        await replyOpenCodePermission(sessionId, reply.upstreamPermissionId, reply.response);
        await markPermissionReplied(job.id, reply.id, reply.response);
      }
    } catch (error) {
      fail(error);
    } finally {
      heartbeatRunning = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, Math.min(config.leaseMs / 2, 1000));

  void (async () => {
    try {
      const response = await fetchOpenCode(
        "/event",
        {
          headers: {
            Accept: "text/event-stream",
          },
          signal: controller.signal,
        },
        0,
      );

      if (!response.body) {
        throw new Error("OpenCode event stream missing body");
      }

      readyResolve();
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";

      while (!settled) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) {
          break;
        }

        buffer += value;
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const dataLines = chunk
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data:\s*/, ""));

          if (dataLines.length === 0) {
            continue;
          }

          const event = JSON.parse(dataLines.join("\n")) as OpenCodeEvent;
          if (getSessionId(event) !== sessionId) {
            continue;
          }

          if (event.type === "permission.asked" || event.type === "permission.updated") {
            const permission = mapPermissionPayload(event);
            if (permission.requestId) {
              await postPermissionRequest(job.id, permission.requestId, permission);
            }
            continue;
          }

          if (event.type === "permission.replied") {
            const props = asRecord(event.properties);
            const requestId = asString(props?.requestID) ?? asString(props?.permissionID);
            const responseValue = asString(props?.reply) ?? asString(props?.response) ?? null;
            if (requestId) {
              await markPermissionReplied(job.id, requestId, responseValue as PermissionReply["response"] | null);
            }
            continue;
          }

          const translated = mapTimelineEvents(event);
          if (translated.length > 0) {
            await postEvents(job.id, translated);
          }

          if (event.type === "session.error") {
            const message = getSessionError(event);
            await postEvents(job.id, [
              {
                type: "session_error",
                payload: {
                  message,
                },
              },
            ]);
            finish({ status: "failed", error: message });
            break;
          }

          if (event.type === "session.idle") {
            finish({
              status: abortForwarded ? "failed" : "completed",
              error: abortForwarded ? "Execution aborted by server request." : null,
            });
            break;
          }
        }
      }

      if (!settled) {
        fail(new Error("OpenCode event stream ended unexpectedly"));
      }
    } catch (error) {
      readyReject(error);
      fail(error);
    } finally {
      clearInterval(interval);
    }
  })();

  return {
    ready,
    done,
    close() {
      if (!settled) {
        settled = true;
      }
      controller.abort();
      clearInterval(interval);
    },
  };
}

async function executeRealJob(job: ClaimedJob) {
  const existingSessionId = job.thread.opencodeSessionId;
  const session = existingSessionId
    ? { id: existingSessionId }
    : await createOpenCodeSession(job.thread.title || `Remote ${job.thread.id}`);
  const sessionId = session.id;

  if (!existingSessionId) {
    await setThreadSession(job.thread.id, sessionId);
  }

  await postEvents(job.id, [
    {
      type: "runner_note",
      payload: {
        runnerId,
        mode: config.executionMode,
        opencodeUrl: config.opencodeUrl,
        directory: config.opencodeDirectory ?? null,
      },
    },
  ]);

  const monitor = createOpenCodeMonitor(job, sessionId);

  try {
    await monitor.ready;
    await promptOpenCodeSession(sessionId, job.prompt);
    const result = await monitor.done;

    await updateStatus(job.id, result.status, result.error);
  } finally {
    monitor.close();
  }
}

async function executeJob(job: ClaimedJob) {
  if (config.executionMode === "stub") {
    await executeStubJob(job);
    return;
  }

  if (config.executionMode === "real" || config.executionMode === "opencode") {
    await executeRealJob(job);
    return;
  }

  throw new Error(`未知的 RUNNER_EXECUTION_MODE: ${config.executionMode}`);
}

async function main() {
  console.log(`[runner] starting ${runnerId}`);
  console.log(`[runner] server=${config.serverUrl} mode=${config.executionMode}`);

  while (true) {
    try {
      const job = await claimJob();
      if (!job) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      try {
        await executeJob(job);
      } catch (error) {
        await failClaimedJob(job.id, error);
        throw error;
      }
    } catch (error) {
      console.error("[runner] loop failed", error);
      await sleep(config.pollIntervalMs);
    }
  }
}

void main();
