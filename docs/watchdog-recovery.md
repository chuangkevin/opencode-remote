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

Automated tests, typecheck, build, and isolated Docker scenarios are repository-level evidence; they do not establish full service lifecycle coverage or production behavior. The canonical validation harness now exists at `packages/server/scripts/watchdog-docker-ab.mjs`; its lifecycle-validator `--self-test` helper check has passed. Actual final Docker execution and independent reviews/CI remain pending. The harness pairs immutable baseline `a3f0c37` with the candidate for two cases: an active owned prompt during health failure, and an idle shared-service health failure. It additionally includes a candidate-only owned-idle forced-termination/recovery-ready case. The harness uses a fake CLI: it does not test the actual OpenCode CLI, the full 180-second grace period, or complete descriptor/PID race coverage, and packaging does not establish runtime pass results for the three cases. Its isolated Docker command must retain read-only mounts, `--network none`, `--read-only`, `--tmpfs /tmp:rw,exec,size=256m`, and resource caps. It runs on Node 24; CI uses Node 22, so those environments are distinct.

Any actual deployment or service restart requires explicit authorization. This document does not claim deployment.
