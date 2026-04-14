export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type Thread = {
  id: string;
  projectId: string;
  title: string;
  opencodeSessionId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type Job = {
  id: string;
  threadId: string;
  prompt: string;
  status: string;
  error: string | null;
  runnerId: string | null;
  leaseExpiresAt: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  abortRequested: number;
};

export type ThreadEvent = {
  id: number;
  threadId: string;
  jobId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type PermissionRequest = {
  id: string;
  threadId: string;
  jobId: string | null;
  upstreamPermissionId: string;
  state: string;
  response: "once" | "always" | "reject" | null;
  payload: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
};

export type ThreadDetail = {
  project: Project | null;
  thread: Thread;
  jobs: Job[];
  events: ThreadEvent[];
  permissionRequests: PermissionRequest[];
};
