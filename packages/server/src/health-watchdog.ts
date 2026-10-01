export type HealthWatchdogAction = "none" | "restart" | "cooldown" | "recovered" | "deferred";

export type HealthWatchdogState = {
  consecutiveFailures: number;
  lastRestartAt?: number;
  cooldownWarnedForRestartAt?: number;
  recoveryDeferredAt?: number;
};

export const HEALTH_RECOVERY_DEFERRAL_MS = 180_000;

export type HealthRecoveryStatus = "busy" | "idle" | "unknown";

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
