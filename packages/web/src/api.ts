import type { Project, Thread, ThreadDetail } from "./types";

async function request<T>(input: RequestInfo, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(input, {
    ...init,
    headers,
  });

  const contentType = response.headers.get("content-type") ?? "";

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  if (response.status === 204 || response.status === 205 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }

  const text = await response.text();
  if (!text.trim()) {
    return undefined as T;
  }

  if (contentType.includes("application/json")) {
    return JSON.parse(text) as T;
  }

  return text as T;
}

export const api = {
  getHealth: () => request<{ ok: boolean; service: string; time: string }>("/health"),
  listProjects: () => request<{ projects: Project[] }>("/api/projects"),
  createProject: (name: string) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  listThreads: (projectId: string) => request<{ project: Project; threads: Thread[] }>(`/api/projects/${projectId}/threads`),
  createThread: (projectId: string, title: string) =>
    request<{ thread: Thread }>(`/api/projects/${projectId}/threads`, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  getThread: (threadId: string) => request<ThreadDetail>(`/api/threads/${threadId}`),
  dispatchPrompt: (threadId: string, prompt: string) =>
    request(`/api/threads/${threadId}/dispatch`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    }),
  abortJob: (jobId: string) =>
    request(`/api/jobs/${jobId}/abort`, {
      method: "POST",
    }),
  answerPermission: (threadId: string, requestId: string, response: "once" | "always" | "reject") =>
    request(`/api/threads/${threadId}/permissions/${requestId}`, {
      method: "POST",
      body: JSON.stringify({ response }),
    }),
};
