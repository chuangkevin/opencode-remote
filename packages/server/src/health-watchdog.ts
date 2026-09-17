export type HealthWatchdogAction = "none" | "restart" | "cooldown" | "recovered";

export type HealthWatchdogState = {
  consecutiveFailures: number;
  lastRestartAt?: number;
  cooldownWarnedForRestartAt?: number;
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
    if (state.consecutiveFailures > 0) {
      return {
        state: {
          ...state,
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
      return { state: nextState, action: "none" };
    }
    return {
      state: {
        ...nextState,
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
