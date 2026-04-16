import fs from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

import { createId } from "../lib/ids.js";

export type ProjectRecord = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type ThreadRecord = {
  id: string;
  projectId: string;
  title: string;
  opencodeSessionId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type JobRecord = {
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

export type ThreadEventRecord = {
  id: number;
  threadId: string;
  jobId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type ThreadRow = {
  id: string;
  project_id: string;
  title: string;
  opencode_session_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

type ProjectRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type JobRow = {
  id: string;
  thread_id: string;
  prompt: string;
  status: string;
  error: string | null;
  runner_id: string | null;
  lease_expires_at: string | null;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  abort_requested: number;
};

type ThreadEventRow = {
  id: number;
  thread_id: string;
  job_id: string | null;
  type: string;
  payload_json: string;
  created_at: string;
};

type PermissionRequestRow = {
  id: string;
  thread_id: string;
  job_id: string | null;
  upstream_permission_id: string;
  state: string;
  response: string | null;
  payload_json: string;
  created_at: string;
  resolved_at: string | null;
};

export type PermissionReplyChoice = "once" | "always" | "reject";

export type PermissionRequestRecord = {
  id: string;
  threadId: string;
  jobId: string | null;
  upstreamPermissionId: string;
  state: string;
  response: PermissionReplyChoice | null;
  payload: Record<string, unknown>;
  createdAt: string;
  resolvedAt: string | null;
};

type PushSubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_label: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

export type PushSubscriptionRecord = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceLabel: string | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
};

export type ClaimedJobRecord = JobRecord & {
  thread: ThreadRecord;
  reclaimed: boolean;
};

type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

type ClaimJobResult = {
  job: JobRecord;
  reclaimed: boolean;
};

export type JobOwnershipError = "not_found" | "runner_mismatch" | "lease_expired" | "not_running";

export type HeartbeatJobResult = {
  abortRequested: boolean;
  permissionReplies: PermissionRequestRecord[];
};

type JobOwnershipResult =
  | { job: JobRecord }
  | {
      error: JobOwnershipError;
    };

type AppendJobThreadEventsResult =
  | {
      job: JobRecord;
      events: ThreadEventRecord[];
    }
  | {
      error: JobOwnershipError;
    };

type UpdateJobStatusResult = JobRecord | { error: JobOwnershipError };

type PermissionRequestMutationResult =
  | {
      job: JobRecord;
      permission: PermissionRequestRecord;
    }
  | {
      error: JobOwnershipError;
    };

const toProjectRecord = (row: ProjectRow): ProjectRecord => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toThreadRecord = (row: ThreadRow): ThreadRecord => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  opencodeSessionId: row.opencode_session_id,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toJobRecord = (row: JobRow): JobRecord => ({
  id: row.id,
  threadId: row.thread_id,
  prompt: row.prompt,
  status: row.status,
  error: row.error,
  runnerId: row.runner_id,
  leaseExpiresAt: row.lease_expires_at,
  queuedAt: row.queued_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  abortRequested: row.abort_requested,
});

const toThreadEventRecord = (row: ThreadEventRow): ThreadEventRecord => ({
  id: row.id,
  threadId: row.thread_id,
  jobId: row.job_id,
  type: row.type,
  payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  createdAt: row.created_at,
});

const toPermissionRequestRecord = (row: PermissionRequestRow): PermissionRequestRecord => ({
  id: row.id,
  threadId: row.thread_id,
  jobId: row.job_id,
  upstreamPermissionId: row.upstream_permission_id,
  state: row.state,
  response: (row.response as PermissionReplyChoice | null) ?? null,
  payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  createdAt: row.created_at,
  resolvedAt: row.resolved_at,
});

const toPushSubscriptionRecord = (row: PushSubscriptionRow): PushSubscriptionRecord => ({
  id: row.id,
  endpoint: row.endpoint,
  p256dh: row.p256dh,
  auth: row.auth,
  deviceLabel: row.device_label,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  revokedAt: row.revoked_at,
});

export class AppDatabase {
  private readonly db: SqliteDatabase;
  private readonly claimNextJobTx: (runnerId: string, leaseMs: number) => ClaimJobResult | null;

  constructor(databasePath: string) {
    const absolutePath = path.resolve(process.cwd(), databasePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });

    this.db = new BetterSqlite3(absolutePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.runMigrations();
    this.claimNextJobTx = this.db.transaction((runnerId: string, leaseMs: number) => {
      const now = new Date().toISOString();
      const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
      const candidate = this.db
        .prepare(
          `SELECT id, thread_id, prompt, status, error, runner_id, lease_expires_at, queued_at, started_at, finished_at, abort_requested
           FROM jobs
           WHERE status = 'queued'
              OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           ORDER BY queued_at ASC
           LIMIT 1`,
        )
        .get(now) as JobRow | undefined;

      if (!candidate) {
        return null;
      }

      const result = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'running',
               runner_id = ?,
               lease_expires_at = ?,
               started_at = CASE WHEN started_at IS NULL THEN ? ELSE started_at END,
               finished_at = NULL,
               error = NULL
           WHERE id = ?
             AND (
               status = 'queued'
               OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )`,
        )
        .run(runnerId, leaseExpiresAt, now, candidate.id, now);

      if (result.changes === 0) {
        return null;
      }

      const claimed = this.getJob(candidate.id);
      if (!claimed) {
        return null;
      }

      return {
        job: claimed,
        reclaimed: candidate.status === "running",
      } satisfies ClaimJobResult;
    });
  }

  private runMigrations() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL
      )
    `);

    const applied = new Set(
      (this.db.prepare("SELECT name FROM _migrations").all() as Array<{ name: string }>).map((r) => r.name),
    );

    const apply = (name: string, fn: () => void) => {
      if (applied.has(name)) return;
      fn();
      this.db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(name, new Date().toISOString());
      console.log(`[db] migration applied: ${name}`);
    };

    apply("001_initial_schema", () => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          opencode_session_id TEXT,
          status TEXT NOT NULL DEFAULT 'idle',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL,
          error TEXT,
          runner_id TEXT,
          lease_expires_at TEXT,
          queued_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          abort_requested INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS thread_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS permission_requests (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
          upstream_permission_id TEXT NOT NULL,
          state TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );

        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id TEXT PRIMARY KEY,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          device_label TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revoked_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_threads_project_updated_at ON threads(project_id, updated_at DESC, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_jobs_thread_queued_at ON jobs(thread_id, queued_at DESC);
        CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(status, lease_expires_at, queued_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_runner_status_lease ON jobs(runner_id, status, lease_expires_at);
        CREATE INDEX IF NOT EXISTS idx_thread_events_thread_id_id ON thread_events(thread_id, id ASC);
        CREATE INDEX IF NOT EXISTS idx_permission_requests_thread_created_at ON permission_requests(thread_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_permission_requests_job_state ON permission_requests(job_id, state, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_push_subscriptions_active_updated_at ON push_subscriptions(revoked_at, updated_at DESC);
      `);
    });

    apply("002_permission_response_column", () => {
      const cols = this.db.prepare("PRAGMA table_info(permission_requests)").all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === "response")) {
        this.db.exec("ALTER TABLE permission_requests ADD COLUMN response TEXT");
      }
    });
  }

  listProjects() {
    const rows = this.db
      .prepare("SELECT id, name, created_at, updated_at FROM projects ORDER BY updated_at DESC, created_at DESC")
      .all() as ProjectRow[];

    return rows.map(toProjectRecord);
  }

  createProject(name: string) {
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      id: createId("prj"),
      name,
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        "INSERT INTO projects (id, name, created_at, updated_at) VALUES (@id, @name, @createdAt, @updatedAt)",
      )
      .run(project);

    return project;
  }

  getProject(projectId: string) {
    const row = this.db
      .prepare("SELECT id, name, created_at, updated_at FROM projects WHERE id = ?")
      .get(projectId) as ProjectRow | undefined;

    return row ? toProjectRecord(row) : null;
  }

  listThreads(projectId: string) {
    const rows = this.db
      .prepare(
        "SELECT id, project_id, title, opencode_session_id, status, created_at, updated_at FROM threads WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC",
      )
      .all(projectId) as ThreadRow[];

    return rows.map(toThreadRecord);
  }

  createThread(projectId: string, title: string) {
    const now = new Date().toISOString();
    const thread: ThreadRecord = {
      id: createId("thr"),
      projectId,
      title,
      opencodeSessionId: null,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        "INSERT INTO threads (id, project_id, title, opencode_session_id, status, created_at, updated_at) VALUES (@id, @projectId, @title, @opencodeSessionId, @status, @createdAt, @updatedAt)",
      )
      .run(thread);

    return thread;
  }

  getThread(threadId: string) {
    const row = this.db
      .prepare(
        "SELECT id, project_id, title, opencode_session_id, status, created_at, updated_at FROM threads WHERE id = ?",
      )
      .get(threadId) as ThreadRow | undefined;

    return row ? toThreadRecord(row) : null;
  }

  listJobs(threadId: string) {
    const rows = this.db
      .prepare(
        "SELECT id, thread_id, prompt, status, error, runner_id, lease_expires_at, queued_at, started_at, finished_at, abort_requested FROM jobs WHERE thread_id = ? ORDER BY queued_at DESC",
      )
      .all(threadId) as JobRow[];

    return rows.map(toJobRecord);
  }

  getJob(jobId: string) {
    const row = this.db
      .prepare(
        "SELECT id, thread_id, prompt, status, error, runner_id, lease_expires_at, queued_at, started_at, finished_at, abort_requested FROM jobs WHERE id = ?",
      )
      .get(jobId) as JobRow | undefined;

    return row ? toJobRecord(row) : null;
  }

  createQueuedJob(threadId: string, prompt: string) {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: createId("job"),
      threadId,
      prompt,
      status: "queued",
      error: null,
      runnerId: null,
      leaseExpiresAt: null,
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      abortRequested: 0,
    };

    this.db
      .prepare(
        "INSERT INTO jobs (id, thread_id, prompt, status, error, runner_id, lease_expires_at, queued_at, started_at, finished_at, abort_requested) VALUES (@id, @threadId, @prompt, @status, @error, @runnerId, @leaseExpiresAt, @queuedAt, @startedAt, @finishedAt, @abortRequested)",
      )
      .run(job);

    this.touchThread(threadId, "queued");
    return job;
  }

  claimNextJob(runnerId: string, leaseMs: number) {
    const claimedResult = this.claimNextJobTx(runnerId, leaseMs) as ClaimJobResult | null;
    if (!claimedResult) {
      return null;
    }

    const claimed = claimedResult.job;
    if (!claimed) {
      return null;
    }

    this.touchThread(claimed.threadId, "running");
    const thread = this.getThread(claimed.threadId);
    if (!thread) {
      return null;
    }

    return {
      ...claimed,
      thread,
      reclaimed: claimedResult.reclaimed,
    } satisfies ClaimedJobRecord;
  }

  heartbeatJob(jobId: string, runnerId: string, leaseMs: number): HeartbeatJobResult | { error: JobOwnershipError } {
    const ownership = this.getOwnedRunningJob(jobId, runnerId);
    if ("error" in ownership) {
      return ownership;
    }

    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const result = this.db
      .prepare(
        "UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND runner_id = ? AND status = 'running'",
      )
      .run(leaseExpiresAt, jobId, runnerId);

    if (result.changes === 0) {
      return { error: "runner_mismatch" satisfies JobOwnershipError };
    }

    return {
      abortRequested: ownership.job.abortRequested === 1,
      permissionReplies: this.listAnsweredPermissionRequests(ownership.job.id),
    } satisfies HeartbeatJobResult;
  }

  updateJobStatus(jobId: string, runnerId: string, status: "completed" | "failed", error: string | null): UpdateJobStatusResult {
    const ownership = this.getOwnedRunningJob(jobId, runnerId);
    if ("error" in ownership) {
      return ownership;
    }

    const finishedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE jobs SET status = ?, error = ?, finished_at = ?, lease_expires_at = NULL WHERE id = ? AND runner_id = ? AND status = 'running'",
      )
      .run(status, error, finishedAt, jobId, runnerId);

    if (result.changes === 0) {
      return { error: "runner_mismatch" satisfies JobOwnershipError };
    }

    const job = this.getJob(jobId);
    if (!job) {
      return { error: "not_found" };
    }

    this.touchThread(job.threadId, status === "completed" ? "idle" : "attention");
    return job;
  }

  requestAbort(jobId: string) {
    const result = this.db.prepare("UPDATE jobs SET abort_requested = 1 WHERE id = ?").run(jobId);
    return result.changes > 0;
  }

  listThreadEvents(threadId: string, afterId = 0) {
    const rows = this.db
      .prepare(
        "SELECT id, thread_id, job_id, type, payload_json, created_at FROM thread_events WHERE thread_id = ? AND id > ? ORDER BY id ASC",
      )
      .all(threadId, afterId) as ThreadEventRow[];

    return rows.map(toThreadEventRecord);
  }

  appendThreadEvent(threadId: string, type: string, payload: Record<string, unknown>, jobId: string | null = null) {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        "INSERT INTO thread_events (thread_id, job_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(threadId, jobId, type, JSON.stringify(payload), createdAt);

    const insertedRow = this.db
      .prepare(
        "SELECT id, thread_id, job_id, type, payload_json, created_at FROM thread_events WHERE id = ?",
      )
      .get(result.lastInsertRowid) as ThreadEventRow;

    this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(createdAt, threadId);
    return toThreadEventRecord(insertedRow);
  }

  appendJobThreadEvents(
    jobId: string,
    runnerId: string,
    events: Array<{ type: string; payload: Record<string, unknown> }>,
  ): AppendJobThreadEventsResult {
    const ownership = this.getOwnedRunningJob(jobId, runnerId);
    if ("error" in ownership) {
      return ownership;
    }

    const insertedEvents = events.map((event) =>
      this.appendThreadEvent(ownership.job.threadId, event.type, event.payload, ownership.job.id),
    );

    return {
      job: ownership.job,
      events: insertedEvents,
    };
  }

  listPermissionRequests(threadId: string) {
    const rows = this.db
      .prepare(
        "SELECT id, thread_id, job_id, upstream_permission_id, state, response, payload_json, created_at, resolved_at FROM permission_requests WHERE thread_id = ? ORDER BY created_at DESC",
      )
      .all(threadId) as PermissionRequestRow[];

    return rows.map(toPermissionRequestRecord);
  }

  upsertPermissionRequest(
    jobId: string,
    runnerId: string,
    input: {
      requestId: string;
      payload: Record<string, unknown>;
    },
  ): PermissionRequestMutationResult {
    const ownership = this.getOwnedRunningJob(jobId, runnerId);
    if ("error" in ownership) {
      return ownership;
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO permission_requests (id, thread_id, job_id, upstream_permission_id, state, response, payload_json, created_at, resolved_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           thread_id = excluded.thread_id,
           job_id = excluded.job_id,
           upstream_permission_id = excluded.upstream_permission_id,
           state = 'pending',
           response = NULL,
           payload_json = excluded.payload_json,
           resolved_at = NULL`,
      )
      .run(input.requestId, ownership.job.threadId, ownership.job.id, input.requestId, JSON.stringify(input.payload), now);

    const row = this.db
      .prepare(
        "SELECT id, thread_id, job_id, upstream_permission_id, state, response, payload_json, created_at, resolved_at FROM permission_requests WHERE id = ?",
      )
      .get(input.requestId) as PermissionRequestRow | undefined;

    if (!row) {
      return { error: "not_found" };
    }

    return {
      job: ownership.job,
      permission: toPermissionRequestRecord(row),
    };
  }

  answerPermissionRequest(threadId: string, requestId: string, response: PermissionReplyChoice) {
    const result = this.db
      .prepare(
        "UPDATE permission_requests SET state = 'answered', response = ?, resolved_at = NULL WHERE id = ? AND thread_id = ? AND state IN ('pending', 'answered')",
      )
      .run(response, requestId, threadId);

    if (result.changes === 0) {
      return null;
    }

    const row = this.db
      .prepare(
        "SELECT id, thread_id, job_id, upstream_permission_id, state, response, payload_json, created_at, resolved_at FROM permission_requests WHERE id = ?",
      )
      .get(requestId) as PermissionRequestRow | undefined;

    return row ? toPermissionRequestRecord(row) : null;
  }

  markPermissionRequestReplied(jobId: string, runnerId: string, requestId: string): PermissionRequestMutationResult {
    const ownership = this.getOwnedRunningJob(jobId, runnerId);
    if ("error" in ownership) {
      return ownership;
    }

    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE permission_requests SET state = 'replied', resolved_at = ? WHERE id = ? AND job_id = ? AND state IN ('answered', 'pending')",
      )
      .run(now, requestId, ownership.job.id);

    if (result.changes === 0) {
      return { error: "not_found" };
    }

    const row = this.db
      .prepare(
        "SELECT id, thread_id, job_id, upstream_permission_id, state, response, payload_json, created_at, resolved_at FROM permission_requests WHERE id = ?",
      )
      .get(requestId) as PermissionRequestRow | undefined;

    if (!row) {
      return { error: "not_found" };
    }

    return {
      job: ownership.job,
      permission: toPermissionRequestRecord(row),
    };
  }

  upsertPushSubscription(input: { endpoint: string; p256dh: string; auth: string; deviceLabel?: string | null }) {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        "SELECT id, endpoint, p256dh, auth, device_label, created_at, updated_at, revoked_at FROM push_subscriptions WHERE endpoint = ?",
      )
      .get(input.endpoint) as PushSubscriptionRow | undefined;

    if (existing) {
      this.db
        .prepare(
          "UPDATE push_subscriptions SET p256dh = ?, auth = ?, device_label = ?, updated_at = ?, revoked_at = NULL WHERE endpoint = ?",
        )
        .run(input.p256dh, input.auth, input.deviceLabel ?? null, now, input.endpoint);

      const updated = this.db
        .prepare(
          "SELECT id, endpoint, p256dh, auth, device_label, created_at, updated_at, revoked_at FROM push_subscriptions WHERE endpoint = ?",
        )
        .get(input.endpoint) as PushSubscriptionRow;

      return toPushSubscriptionRecord(updated);
    }

    const id = createId("push");
    this.db
      .prepare(
        "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, device_label, created_at, updated_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(id, input.endpoint, input.p256dh, input.auth, input.deviceLabel ?? null, now, now);

    return this.getPushSubscriptionByEndpoint(input.endpoint);
  }

  getPushSubscriptionByEndpoint(endpoint: string) {
    const row = this.db
      .prepare(
        "SELECT id, endpoint, p256dh, auth, device_label, created_at, updated_at, revoked_at FROM push_subscriptions WHERE endpoint = ?",
      )
      .get(endpoint) as PushSubscriptionRow | undefined;

    return row ? toPushSubscriptionRecord(row) : null;
  }

  listActivePushSubscriptions() {
    const rows = this.db
      .prepare(
        "SELECT id, endpoint, p256dh, auth, device_label, created_at, updated_at, revoked_at FROM push_subscriptions WHERE revoked_at IS NULL ORDER BY updated_at DESC",
      )
      .all() as PushSubscriptionRow[];

    return rows.map(toPushSubscriptionRecord);
  }

  revokePushSubscription(endpoint: string) {
    const result = this.db
      .prepare("UPDATE push_subscriptions SET revoked_at = ?, updated_at = ? WHERE endpoint = ?")
      .run(new Date().toISOString(), new Date().toISOString(), endpoint);

    return result.changes > 0;
  }

  setThreadSession(threadId: string, sessionId: string) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE threads SET opencode_session_id = ?, updated_at = ? WHERE id = ?")
      .run(sessionId, now, threadId);

    return result.changes > 0 ? this.getThread(threadId) : null;
  }

  markThreadSessionUnhealthy(threadId: string) {
    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE threads SET opencode_session_id = NULL, status = 'attention', updated_at = ? WHERE id = ?")
      .run(now, threadId);

    return result.changes > 0 ? this.getThread(threadId) : null;
  }

  private touchThread(threadId: string, status: string) {
    this.db
      .prepare("UPDATE threads SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), threadId);
  }

  private getOwnedRunningJob(jobId: string, runnerId: string): JobOwnershipResult {
    const row = this.db
      .prepare(
        "SELECT id, thread_id, prompt, status, error, runner_id, lease_expires_at, queued_at, started_at, finished_at, abort_requested FROM jobs WHERE id = ?",
      )
      .get(jobId) as JobRow | undefined;

    if (!row) {
      return { error: "not_found" satisfies JobOwnershipError };
    }

    const job = toJobRecord(row);
    if (job.status !== "running") {
      return { error: "not_running" satisfies JobOwnershipError };
    }

    if (job.runnerId !== runnerId) {
      return { error: "runner_mismatch" satisfies JobOwnershipError };
    }

    if (!job.leaseExpiresAt || job.leaseExpiresAt <= new Date().toISOString()) {
      return { error: "lease_expired" satisfies JobOwnershipError };
    }

    return { job };
  }

  private listAnsweredPermissionRequests(jobId: string) {
    const rows = this.db
      .prepare(
        "SELECT id, thread_id, job_id, upstream_permission_id, state, response, payload_json, created_at, resolved_at FROM permission_requests WHERE job_id = ? AND state = 'answered' AND response IS NOT NULL ORDER BY created_at ASC",
      )
      .all(jobId) as PermissionRequestRow[];

    return rows.map(toPermissionRequestRecord);
  }
}
