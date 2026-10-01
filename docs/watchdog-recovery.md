# Health watchdog recovery

## Behavior change

Before: an unhealthy HTTP health check in managed service mode could be treated as proof that the shared service had stopped, allowing another CLI process to start. An unavailable activity check could also be mistaken for idle.

After: the finite activity grace applies only to managed recovery. The first qualifying managed recovery tick starts one monotonic 180-second grace deadline. Repeated failures and prompts do not renew it. A healthy probe clears the deferral; otherwise recovery may proceed after the deadline. Unmanaged readiness and recovery behavior remains unchanged.

An activity result of `unknown` is never treated as `idle`; malformed status data, request errors, and timeouts therefore defer recovery during the finite grace.

## Shared-service start guard

Before starting a replacement for a shared managed service, the watchdog requires a valid descriptor identifying the expected loopback port and PID, a bounded loopback probe reporting the port absent, and a known descriptor PID confirmed dead. Listener absence, descriptor identity, and PID death are checked again immediately before spawn.

An occupied or unknown listener, invalid/missing/changed descriptor, or live/unknown PID defers recovery and leaves the process shared. A listener acquired during the checks also defers. If another process wins the remaining check-to-bind race, a bind collision or child exit with the listener still occupied is handled as shared: the proxy remains alive and does not terminate that listener. This narrows but cannot eliminate the race.

## Diagnostics and limitations

Watchdog lifecycle records use an ISO timestamp and fixed allowlists of action/reason values. They include only ownership, action, reason, positive safe PID when available, probe category, and bounded failure/prompt/grace counters. Unknown fields are discarded; raw errors, URLs, request bodies, credentials, and session identifiers are not part of this diagnostic format. Logging failures do not block recovery.

Automated tests, typecheck, build, and earlier isolated Docker scenarios are repository-level evidence; they do not establish full service lifecycle coverage or production behavior. The available Docker A/B report covers two scenarios on an earlier candidate; final three-scenario revalidation remains pending. The actual OpenCode CLI and a complete 180-second elapsed-time run were not tested. The canonical `packages/server/scripts/watchdog-docker-ab.mjs` command is pending packaging and is not yet a completed gate.

Any actual deployment or service restart requires explicit authorization. This document does not claim deployment.
