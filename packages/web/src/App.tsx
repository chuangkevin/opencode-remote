import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "./api";
import { APP_VERSION } from "./version";
import type { Job, PermissionRequest, Project, Thread, ThreadDetail, ThreadEvent } from "./types";

type Status = "idle" | "loading" | "error";

function App() {
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [healthText, setHealthText] = useState("檢查中");
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [newThreadTitle, setNewThreadTitle] = useState("");
  const [promptInput, setPromptInput] = useState("");
  const [submittingPrompt, setSubmittingPrompt] = useState(false);
  const lastEventIdRef = useRef(0);
  const errorTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (errorTimerRef.current !== null) {
        window.clearTimeout(errorTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!selectedProjectId) return;
    void loadThreads(selectedProjectId);
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedThreadId) {
      setThreadDetail(null);
      lastEventIdRef.current = 0;
      return;
    }

    let isCancelled = false;
    let eventSource: EventSource | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = () => {
      if (isCancelled || reconnectTimer !== null) {
        return;
      }

      const delay = Math.min(1000 * 2 ** reconnectAttempts, 10000);
      reconnectAttempts += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connectStream();
      }, delay);
    };

    const connectStream = async () => {
      try {
        const detail = await api.getThread(selectedThreadId);
        if (isCancelled) return;

        lastEventIdRef.current = detail.events.at(-1)?.id ?? 0;
        setThreadDetail(detail);
      } catch (error) {
        if (isCancelled) return;
        showError(error, "讀取 thread 失敗");
        scheduleReconnect();
        return;
      }

      if (isCancelled) return;

      const stream = new EventSource(`/api/threads/${selectedThreadId}/stream?after=${lastEventIdRef.current}`);
      eventSource = stream;

      stream.onopen = () => {
        reconnectAttempts = 0;
      };

      stream.addEventListener("timeline", (event) => {
        try {
          const nextEvent = JSON.parse((event as MessageEvent<string>).data) as ThreadEvent;
          lastEventIdRef.current = nextEvent.id;

          setThreadDetail((current) => {
            if (!current || current.thread.id !== nextEvent.threadId) {
              return current;
            }

            const alreadyExists = current.events.some((existingEvent) => existingEvent.id === nextEvent.id);
            const nextEvents = alreadyExists ? current.events : [...current.events, nextEvent];
            const nextJobs = deriveJobsFromEvent(current.jobs, nextEvent);

            return {
              ...current,
              events: nextEvents,
              jobs: nextJobs,
            };
          });

          if (nextEvent.type.startsWith("permission_")) {
            void refreshThread(nextEvent.threadId).catch((error) => {
              showError(error, "同步 permission 狀態失敗");
            });
          }
        } catch (error) {
          showError(error, "即時事件解析失敗");
        }
      });

      stream.onerror = () => {
        if (eventSource !== stream) {
          return;
        }

        stream.close();
        eventSource = null;
        scheduleReconnect();
      };
    };

    void connectStream();

    return () => {
      isCancelled = true;
      clearReconnectTimer();
      eventSource?.close();
    };
  }, [selectedThreadId]);

  function showError(error: unknown, fallbackMessage: string) {
    const message = error instanceof Error && error.message ? error.message : fallbackMessage;
    setErrorMessage(message);

    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
    }

    errorTimerRef.current = window.setTimeout(() => {
      setErrorMessage((current) => (current === message ? null : current));
      errorTimerRef.current = null;
    }, 5000);
  }

  function clearError() {
    setErrorMessage(null);

    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }

  async function bootstrap() {
    try {
      const [health, projectPayload] = await Promise.all([api.getHealth(), api.listProjects()]);
      setHealthText(`${health.service} / ${new Date(health.time).toLocaleTimeString("zh-TW")}`);
      setProjects(projectPayload.projects);
      const initialProjectId = projectPayload.projects[0]?.id ?? null;
      setSelectedProjectId(initialProjectId);
      setStatus("idle");
      clearError();
    } catch (error) {
      setStatus("error");
      showError(error, "初始化失敗");
    }
  }

  async function loadThreads(projectId: string) {
    try {
      const payload = await api.listThreads(projectId);
      setThreads(payload.threads);
      setSelectedThreadId((current) => {
        if (current && payload.threads.some((thread) => thread.id === current)) {
          return current;
        }

        return payload.threads[0]?.id ?? null;
      });
      clearError();
    } catch (error) {
      showError(error, "讀取 threads 失敗");
    }
  }

  async function handleCreateProject() {
    const name = newProjectName.trim();
    if (!name) return;

    try {
      const { project } = await api.createProject(name);
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setNewProjectName("");
      clearError();
    } catch (error) {
      showError(error, "建立專案失敗");
    }
  }

  async function handleCreateThread() {
    if (!selectedProjectId) return;
    const title = newThreadTitle.trim();
    if (!title) return;

    try {
      const { thread } = await api.createThread(selectedProjectId, title);
      setThreads((current) => [thread, ...current]);
      setSelectedThreadId(thread.id);
      setNewThreadTitle("");
      clearError();
    } catch (error) {
      showError(error, "建立 thread 失敗");
    }
  }

  async function handleDispatchPrompt() {
    if (!selectedThreadId) return;

    const prompt = promptInput.trim();
    if (!prompt) return;

    setSubmittingPrompt(true);
    try {
      await api.dispatchPrompt(selectedThreadId, prompt);
      setPromptInput("");
      await refreshThread(selectedThreadId);
      clearError();
    } catch (error) {
      showError(error, "派發 prompt 失敗");
    } finally {
      setSubmittingPrompt(false);
    }
  }

  async function handleAbortLatestJob(job: Job | undefined) {
    if (!job) return;

    try {
      await api.abortJob(job.id);
      await refreshThread(job.threadId);
      clearError();
    } catch (error) {
      showError(error, "中止工作失敗");
    }
  }

  async function handlePermissionResponse(permission: PermissionRequest, response: "once" | "always" | "reject") {
    try {
      await api.answerPermission(permission.threadId, permission.id, response);
      await refreshThread(permission.threadId);
      clearError();
    } catch (error) {
      showError(error, "回覆權限請求失敗");
    }
  }

  async function refreshThread(threadId: string) {
    const detail = await api.getThread(threadId);
    lastEventIdRef.current = detail.events.at(-1)?.id ?? 0;
    setThreadDetail(detail);
  }

  const latestJob = threadDetail?.jobs[0];
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  return (
    <div className="app-shell relative px-4 pb-[calc(20px+env(safe-area-inset-bottom))] pt-[calc(20px+env(safe-area-inset-top))] text-slate-50 sm:px-6">
      <div className="app-shell__content mx-auto flex max-w-7xl flex-col gap-4 lg:grid lg:grid-cols-[280px_300px_minmax(0,1fr)]">
        <header className="lg:col-span-3">
          <div className="rounded-2xl border border-grid bg-steel/90 px-4 py-4 shadow-panel backdrop-blur">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.3em] text-signal">OpenCode Remote</p>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight">iPhone PWA Dispatch Console</h1>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-ash">
                  手機只負責發號施令，真正的執行留在家中 runner。這版已經打通 thread、queue、SSE、stub runner。
                </p>
              </div>
              <div className="rounded-xl border border-grid px-3 py-2 text-right text-xs text-ash">
                <div>狀態：{status === "loading" ? "載入中" : status === "error" ? "錯誤" : "就緒"}</div>
                <div className="mt-1">{healthText}</div>
              </div>
            </div>
          </div>
        </header>

        <section className="rounded-2xl border border-grid bg-steel/85 p-4 shadow-panel backdrop-blur">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-signal">專案</h2>
              <p className="mt-1 text-xs text-ash">先選定永續 thread 所屬的 workspace。</p>
            </div>
          </div>

          <div className="flex gap-2">
            <input
              value={newProjectName}
              onChange={(event) => setNewProjectName(event.target.value)}
              placeholder="新增專案，例如 Home Lab"
              className="h-11 min-w-0 flex-1 rounded-xl border border-grid bg-ink px-3 text-sm outline-none transition-colors focus:border-signal"
            />
            <button
              onClick={() => void handleCreateProject()}
              className="h-11 rounded-xl border border-signal/60 px-4 text-sm font-medium text-signal transition-colors hover:bg-signal/10"
            >
              建立
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {projects.length === 0 ? (
              <EmptyState title="尚未建立專案" description="先建立一個 project，之後所有 thread 都掛在這裡。" />
            ) : (
              projects.map((project) => {
                const active = project.id === selectedProjectId;
                return (
                  <button
                    key={project.id}
                    onClick={() => setSelectedProjectId(project.id)}
                    className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                      active ? "border-signal bg-signal/10" : "border-grid bg-ink/70 hover:bg-ink"
                    }`}
                  >
                    <div className="text-sm font-medium">{project.name}</div>
                    <div className="mt-1 text-xs text-ash">{formatTime(project.updatedAt)}</div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-grid bg-steel/85 p-4 shadow-panel backdrop-blur">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-signal">Threads</h2>
            <p className="mt-1 text-xs text-ash">一條 thread 對應一條可重用的 OpenCode session。</p>
          </div>

          <div className="mt-4 flex gap-2">
            <input
              value={newThreadTitle}
              onChange={(event) => setNewThreadTitle(event.target.value)}
              placeholder="新 thread 標題"
              disabled={!selectedProjectId}
              className="h-11 min-w-0 flex-1 rounded-xl border border-grid bg-ink px-3 text-sm outline-none transition-colors focus:border-signal disabled:opacity-50"
            />
            <button
              onClick={() => void handleCreateThread()}
              disabled={!selectedProjectId}
              className="h-11 rounded-xl border border-signal/60 px-4 text-sm font-medium text-signal transition-colors hover:bg-signal/10 disabled:opacity-50"
            >
              建立
            </button>
          </div>

          <div className="mt-4 space-y-2">
            {!selectedProject ? (
              <EmptyState title="先選 project" description="左側選定 project 後，這裡才會出現 threads。" />
            ) : threads.length === 0 ? (
              <EmptyState title="尚無 thread" description="建立第一條 thread，開始把任務派到桌機 runner。" />
            ) : (
              threads.map((thread) => {
                const active = thread.id === selectedThreadId;
                return (
                  <button
                    key={thread.id}
                    onClick={() => setSelectedThreadId(thread.id)}
                    className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                      active ? "border-signal bg-signal/10" : "border-grid bg-ink/70 hover:bg-ink"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1 truncate text-sm font-medium">{thread.title}</div>
                      <span className="rounded-full border border-grid px-2 py-1 text-[11px] uppercase tracking-[0.2em] text-ash">
                        {thread.status}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-xs text-ash">
                      {thread.opencodeSessionId ? `Session ${thread.opencodeSessionId}` : "尚未映射 session"}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </section>

        <main className="rounded-2xl border border-grid bg-steel/85 p-4 shadow-panel backdrop-blur">
          {!threadDetail ? (
            <EmptyState title="選擇 thread" description="右側會顯示 timeline、job 狀態，以及 prompt composer。" />
          ) : (
            <div className="flex h-full flex-col gap-4">
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-grid bg-ink/70 p-4">
                <div>
                  <p className="font-mono text-xs uppercase tracking-[0.24em] text-signal">{threadDetail.project?.name ?? "未命名專案"}</p>
                  <h2 className="mt-2 text-xl font-semibold">{threadDetail.thread.title}</h2>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-ash">
                    <span>Thread: {threadDetail.thread.id}</span>
                    <span>Session: {threadDetail.thread.opencodeSessionId ?? "pending"}</span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleAbortLatestJob(latestJob)}
                    disabled={!latestJob || latestJob.status !== "running"}
                    className="h-11 rounded-xl border border-red-400/40 px-4 text-sm text-red-200 transition-colors hover:bg-red-500/10 disabled:opacity-40"
                  >
                    中止目前工作
                  </button>
                </div>
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_320px]">
                <section className="rounded-2xl border border-grid bg-ink/70 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-signal">Timeline</h3>
                    <span className="text-xs text-ash">{threadDetail.events.length} events</span>
                  </div>

                  <div className="max-h-[48vh] space-y-3 overflow-auto pr-1">
                    {threadDetail.events.length === 0 ? (
                      <EmptyState title="尚無事件" description="送出第一個 prompt 後，這裡會開始累積 thread timeline。" />
                    ) : (
                      threadDetail.events.map((event) => <TimelineItem key={event.id} event={event} />)
                    )}
                  </div>
                </section>

                <aside className="space-y-4">
                  <section className="rounded-2xl border border-grid bg-ink/70 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-signal">Jobs</h3>
                      <span className="text-xs text-ash">{threadDetail.jobs.length} 筆</span>
                    </div>
                    <div className="space-y-2">
                      {threadDetail.jobs.map((job) => (
                        <div key={job.id} className="rounded-xl border border-grid px-3 py-3 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium uppercase tracking-[0.2em] text-xs text-signal">{job.status}</span>
                            <span className="text-[11px] text-ash">{formatTime(job.queuedAt)}</span>
                          </div>
                          <div className="mt-2 line-clamp-3 text-slate-200">{job.prompt}</div>
                          {job.error ? <div className="mt-2 text-xs text-red-200">{job.error}</div> : null}
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="rounded-2xl border border-grid bg-ink/70 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-signal">Permissions</h3>
                      <span className="text-xs text-ash">{threadDetail.permissionRequests.length} 筆</span>
                    </div>
                    <div className="space-y-2">
                      {threadDetail.permissionRequests.length === 0 ? (
                        <EmptyState title="目前沒有待處理權限" description="當本地 OpenCode 需要批准時，這裡會出現操作按鈕。" />
                      ) : (
                        threadDetail.permissionRequests.map((permission) => {
                          const patterns = Array.isArray(permission.payload.patterns)
                            ? permission.payload.patterns.filter((item): item is string => typeof item === "string")
                            : [];
                          const title = typeof permission.payload.title === "string" ? permission.payload.title : permission.id;
                          const permissionName =
                            typeof permission.payload.permission === "string" ? permission.payload.permission : "permission";
                          const isPending = permission.state === "pending";

                          return (
                            <div key={permission.id} className="rounded-xl border border-grid px-3 py-3 text-sm">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium uppercase tracking-[0.2em] text-xs text-signal">{permission.state}</span>
                                <span className="text-[11px] text-ash">{formatTime(permission.createdAt)}</span>
                              </div>
                              <div className="mt-2 font-medium text-slate-100">{title}</div>
                              <div className="mt-1 text-xs text-ash">{permissionName}</div>
                              {patterns.length > 0 ? <div className="mt-2 text-xs text-ash">{patterns.join(", ")}</div> : null}
                              {permission.response ? <div className="mt-2 text-xs text-signal">已回覆：{permission.response}</div> : null}
                              {isPending ? (
                                <div className="mt-3 grid grid-cols-3 gap-2">
                                  <button
                                    onClick={() => void handlePermissionResponse(permission, "once")}
                                    className="h-10 rounded-xl border border-signal/40 text-xs text-signal transition-colors hover:bg-signal/10"
                                  >
                                    once
                                  </button>
                                  <button
                                    onClick={() => void handlePermissionResponse(permission, "always")}
                                    className="h-10 rounded-xl border border-emerald-400/40 text-xs text-emerald-200 transition-colors hover:bg-emerald-500/10"
                                  >
                                    always
                                  </button>
                                  <button
                                    onClick={() => void handlePermissionResponse(permission, "reject")}
                                    className="h-10 rounded-xl border border-red-400/40 text-xs text-red-200 transition-colors hover:bg-red-500/10"
                                  >
                                    reject
                                  </button>
                                </div>
                              ) : null}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </section>

                  <section className="rounded-2xl border border-grid bg-ink/70 p-4">
                    <h3 className="text-sm font-semibold uppercase tracking-[0.24em] text-signal">Dispatch</h3>
                    <textarea
                      value={promptInput}
                      onChange={(event) => setPromptInput(event.target.value)}
                      placeholder="例如：幫我檢查 server 的排程 crash 原因，跑相關測試並修掉。"
                      className="mt-3 min-h-36 w-full rounded-xl border border-grid bg-[#090c10] px-3 py-3 text-sm leading-6 outline-none transition-colors focus:border-signal"
                    />
                    <button
                      onClick={() => void handleDispatchPrompt()}
                      disabled={submittingPrompt}
                      className="mt-3 h-11 w-full rounded-xl border border-signal bg-signal/10 px-4 text-sm font-medium text-signal transition-colors hover:bg-signal/15 disabled:opacity-50"
                    >
                      {submittingPrompt ? "送出中..." : "派發到 runner"}
                    </button>
                  </section>
                </aside>
              </div>
            </div>
          )}
        </main>
      </div>

      {errorMessage ? (
        <div className="pointer-events-none fixed inset-x-4 bottom-[calc(16px+env(safe-area-inset-bottom))] z-50 rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-100 shadow-panel">
          {errorMessage}
        </div>
      ) : null}

      <footer className="mx-auto mt-4 max-w-7xl px-1 pb-2 text-right font-mono text-[11px] text-ash">v{APP_VERSION}</footer>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-grid bg-ink/40 px-4 py-6 text-sm text-ash">
      <div className="font-medium text-slate-200">{title}</div>
      <div className="mt-2 leading-6">{description}</div>
    </div>
  );
}

function TimelineItem({ event }: { event: ThreadEvent }) {
  const label = getEventLabel(event);
  const payloadText = getEventPayloadText(event);

  return (
    <article className="rounded-2xl border border-grid bg-[#090c10] px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-xs uppercase tracking-[0.24em] text-signal">{label}</div>
        <div className="text-[11px] text-ash">#{event.id} / {formatTime(event.createdAt)}</div>
      </div>
      {payloadText ? <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-6 text-slate-100">{payloadText}</pre> : null}
    </article>
  );
}

function getEventLabel(event: ThreadEvent) {
  switch (event.type) {
    case "user_prompt":
      return "Prompt";
    case "assistant_message":
      return "Assistant";
    case "job_queued":
      return "Queued";
    case "job_completed":
      return "Completed";
    case "job_failed":
      return "Failed";
    case "runner_claimed":
      return "Runner";
    case "session_mapped":
      return "Session";
    default:
      return event.type;
  }
}

function getEventPayloadText(event: ThreadEvent) {
  if (typeof event.payload.text === "string") {
    return event.payload.text;
  }

  if (typeof event.payload.prompt === "string") {
    return event.payload.prompt;
  }

  return JSON.stringify(event.payload, null, 2);
}

function deriveJobsFromEvent(currentJobs: Job[], event: ThreadEvent) {
  if (!event.jobId) {
    return currentJobs;
  }

  return currentJobs.map((job) => {
    if (job.id !== event.jobId) return job;

    if (event.type === "job_completed") {
      return { ...job, status: "completed", finishedAt: event.createdAt, error: null };
    }

    if (event.type === "job_failed") {
      return {
        ...job,
        status: "failed",
        finishedAt: event.createdAt,
        error: typeof event.payload.error === "string" ? event.payload.error : null,
      };
    }

    if (event.type === "runner_claimed") {
      return { ...job, status: "running", startedAt: event.createdAt };
    }

    if (event.type === "abort_requested") {
      return { ...job, abortRequested: 1 };
    }

    return job;
  });
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default App;
