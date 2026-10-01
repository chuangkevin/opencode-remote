import net from "node:net";

export type HealthWatchdogAction = "none" | "restart" | "cooldown" | "recovered" | "deferred";

export type HealthLifecycleDiagnostic = {
  timestamp: string;
  ownership: "owned" | "shared";
  action: "probe" | "defer" | "skipped" | "start" | "restart" | "exit" | "terminate" | "force-terminate" | "recovered";
  reason: "probe-result" | "failure-threshold" | "active-prompts" | "cooldown" | "shared-listener" | "shared-pid" | "ownership-unavailable" | "recovery-started" | "recovery-ready" | "recovery-failed" | "child-exit" | "termination" | "forced-termination" | "healthy-reset";
  pid?: number;
  probe: "healthy" | "unhealthy" | "unknown";
  consecutiveFailures: number;
  activePrompts: number;
  graceRemainingMs: number;
};

const lifecycleActions = new Set<HealthLifecycleDiagnostic["action"]>([
  "probe", "defer", "skipped", "start", "restart", "exit", "terminate", "force-terminate", "recovered",
]);
const lifecycleReasons = new Set<HealthLifecycleDiagnostic["reason"]>([
  "probe-result", "failure-threshold", "active-prompts", "cooldown", "shared-listener", "shared-pid",
  "ownership-unavailable", "recovery-started", "recovery-ready", "recovery-failed", "child-exit",
  "termination", "forced-termination", "healthy-reset",
]);

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, Math.floor(value))) : 0;
}

function validPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function formatHealthLifecycleDiagnostic(
  input: Omit<HealthLifecycleDiagnostic, "timestamp"> & { timestamp?: unknown; now?: () => number; [key: string]: unknown },
): string {
  let timestamp: string;
  try {
    const candidate = input.timestamp;
    timestamp = typeof candidate === "string" && Number.isFinite(Date.parse(candidate))
      ? new Date(candidate).toISOString()
      : new Date((input.now ?? Date.now)()).toISOString();
  } catch {
    timestamp = new Date(0).toISOString();
  }
  const ownership = input.ownership === "owned" ? "owned" : "shared";
  const action = lifecycleActions.has(input.action) ? input.action : "skipped";
  const reason = lifecycleReasons.has(input.reason) ? input.reason : "ownership-unavailable";
  const probe = input.probe === "healthy" || input.probe === "unhealthy" ? input.probe : "unknown";
  const record: HealthLifecycleDiagnostic = {
    timestamp, ownership, action, reason,
    ...(validPid(input.pid) ? { pid: input.pid } : {}),
    probe,
    consecutiveFailures: boundedCount(input.consecutiveFailures),
    activePrompts: boundedCount(input.activePrompts),
    graceRemainingMs: boundedCount(input.graceRemainingMs),
  };
  return `[opencode-remote] health-watchdog ${JSON.stringify(record)}`;
}

export function emitHealthLifecycleDiagnostic(
  input: Parameters<typeof formatHealthLifecycleDiagnostic>[0],
  logger: (line: string) => void = (line) => console.warn(line),
): void {
  try { logger(formatHealthLifecycleDiagnostic(input)); } catch { /* diagnostics must never affect recovery */ }
}

export function signalChildWithHealthDiagnostic<T extends { kill(signal: NodeJS.Signals): unknown }>(input: {
  child: T;
  signal: "SIGTERM" | "SIGKILL";
  context: Omit<HealthLifecycleDiagnostic, "timestamp" | "action" | "reason">;
  logger?: (line: string) => void;
}): void {
  emitHealthLifecycleDiagnostic({
    ...input.context,
    action: input.signal === "SIGTERM" ? "terminate" : "force-terminate",
    reason: input.signal === "SIGTERM" ? "termination" : "forced-termination",
  }, input.logger);
  input.child.kill(input.signal);
}

export type HealthWatchdogState = {
  consecutiveFailures: number;
  lastRestartAt?: number;
  cooldownWarnedForRestartAt?: number;
  recoveryDeferredAt?: number;
};

export const HEALTH_RECOVERY_DEFERRAL_MS = 180_000;

export type HealthRecoveryStatus = "busy" | "idle" | "unknown";

export type ManagedServiceRecoveryDecision = { action: "spawn" | "defer"; reason: string };

export type ManagedServiceIdentity = { url: string; port: number; pid: number };

export function validateManagedServiceIdentity(descriptor: { url?: unknown; pid?: unknown } | undefined): ManagedServiceIdentity | undefined {
  if (!descriptor || typeof descriptor.url !== "string" || !Number.isSafeInteger(descriptor.pid) || (descriptor.pid as number) <= 0) return undefined;
  try {
    const url = new URL(descriptor.url);
    const portMatch = descriptor.url.match(/^https?:\/\/[^/?#]*:(\d+)(?:[/?#]|$)/i);
    const port = portMatch ? Number(portMatch[1]) : NaN;
    const effectivePort = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535 || effectivePort !== port) return undefined;
    return { url: `${url.protocol}//${url.host}`, port, pid: descriptor.pid as number };
  } catch { return undefined; }
}

export function commitHealthRecoveryOutcome<T extends HealthWatchdogState>(
  original: T,
  proposed: HealthWatchdogState,
  outcome: "owned-ready" | "shared-reused" | "skipped" | "failed",
  actualNow: number,
  managed = true,
): HealthWatchdogState {
  if (!managed) return proposed;
  if (outcome !== "owned-ready") return original;
  return { consecutiveFailures: 0, lastRestartAt: actualNow, cooldownWarnedForRestartAt: undefined };
}

export function ownsManagedSpawn(
  child: { exitCode?: number | null; signalCode?: NodeJS.Signals | null; pid?: number | undefined },
  currentChild: object,
  readinessConfirmed: boolean,
  descriptorPid?: number,
): boolean {
  return readinessConfirmed && child === currentChild && child.exitCode == null && child.signalCode == null &&
    Number.isSafeInteger(child.pid) && (child.pid ?? 0) > 0 && Number.isSafeInteger(descriptorPid) &&
    (descriptorPid ?? 0) > 0 && descriptorPid === child.pid;
}

export function managedSpawnExitAction(serviceMode: boolean, listener: "occupied" | "absent" | "unknown"): "preserve-shared" | "fatal" {
  return serviceMode && listener !== "absent" ? "preserve-shared" : "fatal";
}

export async function handleRestartReadinessFailure<T>(input: {
  serviceMode: boolean;
  candidate: T | undefined;
  terminateCandidate: (candidate: T) => Promise<void>;
  fatalExit: () => Promise<void>;
  managedFailure: () => Promise<void>;
}): Promise<void> {
  if (input.serviceMode) {
    await input.managedFailure();
    return;
  }
  if (input.candidate !== undefined) await input.terminateCandidate(input.candidate);
  await input.fatalExit();
}

export async function probeLoopbackListener(port: number, timeoutMs: number): Promise<"occupied" | "absent" | "unknown"> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => finish("unknown"), Math.max(1, timeoutMs));
    const finish = (result: "occupied" | "absent" | "unknown"): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish("occupied"));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED" ? "absent" : "unknown"));
  });
}

export async function decideManagedServiceRecovery(input: {
  port: number;
  pid?: number;
  timeoutMs: number;
  probe?: (port: number, timeoutMs: number) => Promise<"occupied" | "absent" | "unknown">;
  isPidAlive?: (pid: number) => boolean | "unknown";
  getSnapshot?: () => Promise<{ url?: string; port?: number; pid?: number } | undefined>;
}): Promise<ManagedServiceRecoveryDecision> {
  const snapshot = input.getSnapshot ? await input.getSnapshot() : undefined;
  if (input.getSnapshot && (!snapshot || snapshot.port !== input.port ||
    !isExpectedLoopbackUrl(snapshot.url, input.port) || snapshot.pid !== input.pid)) {
    return { action: "defer", reason: "managed-snapshot-changed-or-invalid" };
  }
  const listener = await (input.probe ?? probeLoopbackListener)(input.port, input.timeoutMs);
  if (listener !== "absent") return { action: "defer", reason: listener === "occupied" ? "listener-occupied" : "listener-unknown" };
  if (!Number.isSafeInteger(input.pid) || (input.pid ?? 0) <= 0) return { action: "defer", reason: "pid-unknown" };
  const isPidAlive = input.isPidAlive ?? ((pid: number): boolean | "unknown" => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : "unknown"; }
  });
  const alive = isPidAlive(input.pid!);
  if (alive !== false) return { action: "defer", reason: alive === true ? "shared-pid-live" : "pid-unknown" };
  // Last-moment listener revalidation narrows, but cannot eliminate, the race
  // before the child binds; bind failure is handled by the caller as shared.
  const recheck = await (input.probe ?? probeLoopbackListener)(input.port, input.timeoutMs);
  if (recheck !== "absent") return { action: "defer", reason: recheck === "occupied" ? "listener-acquired" : "listener-recheck-unknown" };
  if (input.getSnapshot) {
    const latest = await input.getSnapshot();
    if (!latest || latest.port !== input.port || latest.pid !== input.pid || !isExpectedLoopbackUrl(latest.url, input.port)) {
      return { action: "defer", reason: "managed-snapshot-changed-or-invalid" };
    }
  }
  if (isPidAlive(input.pid!) !== false) return { action: "defer", reason: "pid-changed-or-live" };
  const finalListener = await (input.probe ?? probeLoopbackListener)(input.port, input.timeoutMs);
  if (finalListener !== "absent") return { action: "defer", reason: finalListener === "occupied" ? "listener-acquired" : "listener-recheck-unknown" };
  return { action: "spawn", reason: "listener-absent-pid-dead" };
}

function isExpectedLoopbackUrl(value: string | undefined, port: number): boolean {
  const identity = validateManagedServiceIdentity({ url: value, pid: 1 });
  return identity?.port === port;
}

export type HealthRecoveryPolicyInput = {
  managed: boolean;
  ownsOpenCodeProcess: boolean;
  ownedChildExited: boolean;
};

export function healthRecoveryPolicy(input: HealthRecoveryPolicyInput): {
  lookupActivity: boolean;
  deferRecovery: boolean;
  effectiveOwnedChildExited: boolean;
} {
  const effectiveOwnedChildExited = input.ownsOpenCodeProcess && input.ownedChildExited;
  return {
    lookupActivity: input.managed && !effectiveOwnedChildExited,
    deferRecovery: input.managed,
    effectiveOwnedChildExited,
  };
}

export type HealthRecoveryEvaluationInput = {
  state: HealthWatchdogState;
  probeOk: boolean;
  wallNow: number;
  monotonicNow: number;
  options: HealthWatchdogOptions;
  activityStatus: HealthRecoveryStatus;
  activePrompts: number;
  ownedChildExited: boolean;
  managed?: boolean;
  ownsOpenCodeProcess?: boolean;
};

export type HealthWatchdogOptions = {
  failures: number;
  restartCooldownMs: number;
};

export function initialHealthWatchdogState(): HealthWatchdogState {
  return { consecutiveFailures: 0 };
}

export function healthRestartCooldownRemainingMs(
  state: HealthWatchdogState,
  now: number,
  opts: HealthWatchdogOptions,
): number {
  if (state.lastRestartAt === undefined) return 0;
  return Math.max(0, Math.max(0, opts.restartCooldownMs) - (now - state.lastRestartAt));
}

export function nextHealthState(
  state: HealthWatchdogState,
  probeOk: boolean,
  now: number,
  opts: HealthWatchdogOptions,
): { state: HealthWatchdogState; action: HealthWatchdogAction } {
  if (probeOk) {
    if (state.recoveryDeferredAt !== undefined) {
      const recoveredState = withoutRecoveryDeferral(state);
      if (state.consecutiveFailures === 0) return { state: recoveredState, action: "none" };
      return { state: { ...recoveredState, consecutiveFailures: 0, cooldownWarnedForRestartAt: undefined }, action: "recovered" };
    }
    if (state.consecutiveFailures > 0) {
      return {
        state: {
          ...withoutRecoveryDeferral(state),
          consecutiveFailures: 0,
          cooldownWarnedForRestartAt: undefined,
        },
        action: "recovered",
      };
    }
    return { state, action: "none" };
  }

  const failures = Math.max(1, opts.failures);
  const nextState: HealthWatchdogState = {
    ...state,
    consecutiveFailures: state.consecutiveFailures + 1,
  };
  if (nextState.consecutiveFailures < failures) {
    return { state: nextState, action: "none" };
  }

  const remainingCooldownMs = healthRestartCooldownRemainingMs(nextState, now, opts);
  if (remainingCooldownMs > 0 && nextState.lastRestartAt !== undefined) {
    if (nextState.cooldownWarnedForRestartAt === nextState.lastRestartAt) {
      return { state: withoutRecoveryDeferral(nextState), action: "none" };
    }
    return {
      state: {
        ...withoutRecoveryDeferral(nextState),
        cooldownWarnedForRestartAt: nextState.lastRestartAt,
      },
      action: "cooldown",
    };
  }

  return {
    state: {
      consecutiveFailures: 0,
      lastRestartAt: now,
      cooldownWarnedForRestartAt: undefined,
    },
    action: "restart",
  };
}

export function evaluateHealthRecovery(
  input: HealthRecoveryEvaluationInput,
): { state: HealthWatchdogState; action: HealthWatchdogAction } {
  const proposed = nextHealthState(input.state, input.probeOk, input.wallNow, input.options);
  if (proposed.action !== "restart") return proposed;

  const policy = healthRecoveryPolicy({
    managed: input.managed ?? true,
    ownsOpenCodeProcess: input.ownsOpenCodeProcess ?? input.ownedChildExited,
    ownedChildExited: input.ownedChildExited,
  });
  if (!policy.deferRecovery) return proposed;

  const recoveryIsActive = !policy.effectiveOwnedChildExited &&
    (input.activePrompts > 0 || input.activityStatus !== "idle");
  if (!recoveryIsActive) return proposed;

  const recoveryDeferredAt = input.state.recoveryDeferredAt ?? input.monotonicNow;
  if (input.monotonicNow - recoveryDeferredAt >= HEALTH_RECOVERY_DEFERRAL_MS) return proposed;

  return {
    action: "deferred",
    state: {
      ...input.state,
      consecutiveFailures: input.state.consecutiveFailures + 1,
      recoveryDeferredAt,
    },
  };
}

export async function fetchHealthRecoveryActivityStatus(
  request: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
): Promise<HealthRecoveryStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await request(controller.signal);
    if (!response.ok) return "unknown";
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "unknown";
    const envelope = payload as { data?: unknown };
    const statuses = envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
      ? envelope.data as Record<string, unknown>
      : payload as Record<string, unknown>;
    let busy = false;
    for (const value of Object.values(statuses)) {
      if (!value || typeof value !== "object" || Array.isArray(value) || !("type" in value)) return "unknown";
      const type = (value as { type?: unknown }).type;
      if (type === "running" || type === "busy" || type === "retry") busy = true;
      else if (type !== "idle") return "unknown";
    }
    return busy ? "busy" : "idle";
  } catch {
    return "unknown";
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

export function shouldDeferHealthRecovery(
  input: {
    state: HealthWatchdogState;
    now: number;
    activePrompts: number;
    status: HealthRecoveryStatus;
    deferralMs?: number;
  },
): boolean {
  const since = input.state.recoveryDeferredAt;
  if (since === undefined) return false;
  if (input.now - since >= Math.max(0, input.deferralMs ?? HEALTH_RECOVERY_DEFERRAL_MS)) return false;
  return input.activePrompts > 0 || input.status !== "idle";
}

export function classifyPromptCreatingRequest(method?: string, requestUrl?: string): boolean {
  if (method !== "POST" || !requestUrl) return false;
  try {
    const pathname = new URL(requestUrl, "http://opencode-remote.local").pathname;
    return /^\/(?:api\/)?session\/[^/]+\/(?:message|prompt|prompt_async|command|synthetic)$/.test(pathname);
  } catch {
    return false;
  }
}

export function startHealthRecoveryDeferral(state: HealthWatchdogState, now: number): HealthWatchdogState {
  return state.recoveryDeferredAt === undefined ? { ...state, recoveryDeferredAt: now } : state;
}

function withoutRecoveryDeferral(state: HealthWatchdogState): HealthWatchdogState {
  const { recoveryDeferredAt: _recoveryDeferredAt, ...rest } = state;
  return rest;
}

export function trackPromptRequest(
  req: {
    method?: string;
    url?: string;
    once(event: string, listener: (...args: any[]) => void): unknown;
    off(event: string, listener: (...args: any[]) => void): unknown;
  },
  res: {
    once(event: string, listener: (...args: any[]) => void): unknown;
    off(event: string, listener: (...args: any[]) => void): unknown;
  },
  active: Set<symbol>,
): () => void {
  if (!classifyPromptCreatingRequest(req.method, req.url)) return () => undefined;
  const id = Symbol("active-prompt");
  active.add(id);
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    active.delete(id);
    req.off("aborted", cleanup);
    req.off("error", cleanup);
    res.off("finish", cleanup);
    res.off("close", cleanup);
  };
  req.once("aborted", cleanup);
  req.once("error", cleanup);
  res.once("finish", cleanup);
  res.once("close", cleanup);
  return cleanup;
}
