#!/bin/bash

set -euo pipefail

if [[ "${OPENCODE_UPDATER_CLEAN_ENV:-}" != "1" ]]; then
  exec /usr/bin/env -i \
    HOME="/Users/kevin" \
    USER="kevin" \
    LOGNAME="kevin" \
    SHELL="/bin/zsh" \
    PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
    TMPDIR="/tmp" \
    LANG="en_US.UTF-8" \
    OPENCODE_UPDATER_CLEAN_ENV="1" \
    /bin/bash "$0" "$@"
fi

readonly NODE_BIN="/opt/homebrew/bin/node"
# OpenCode 2.x: the CLI is the one bundled with OpenCode Desktop, which updates
# itself. The updater watches that folder and re-points run-opencode-sara.sh.
readonly DESKTOP_CLI_ROOT="/Users/kevin/Library/Application Support/ai.opencode.desktop/cli"
readonly RUN_SCRIPT="/Users/kevin/.local/share/opencode-remote/run-opencode-sara.sh"
readonly RUN_SCRIPT_BACKUP="/Users/kevin/.local/share/opencode-remote/run-opencode-sara.sh.bak-updater"
readonly HELPER="/Users/kevin/.local/share/opencode-remote/update-opencode-sara-json.mjs"
readonly OPENCODE_DIRECTORY="/Users/kevin/Documents/Projects"
readonly HEALTH_URL="http://100.113.121.103:9223/remote-health"
readonly STATUS_URL="http://100.113.121.103:9223/c/session-status?strict=1"
readonly FILE_CONTENT_URL="http://100.113.121.103:9223/api/fs/read/.opencode-remote/remote-fda-probe.txt"
readonly FDA_PROBE_FILE="/Users/kevin/Documents/Projects/.opencode-remote/remote-fda-probe.txt"
readonly FDA_PROBE_CONTENT="opencode-remote FDA probe v1"
readonly SKYNET_MAINTENANCE_URL="http://10.11.12.55:3001/api/maintenance"
readonly LOCK_FILE="/Users/kevin/.local/share/opencode-remote/update-opencode-sara.lock"
readonly QUIESCE_FILE="/Users/kevin/.local/share/opencode-remote/update-opencode-sara.quiesce"
readonly UPDATE_BLOCK_FILE="/Users/kevin/.local/share/opencode-remote/update-opencode-sara.blocked"
readonly HEALTH_ATTEMPTS=30
readonly HEALTH_WAIT_SECONDS=2
UID_VALUE="$(/usr/bin/id -u)"
readonly UID_VALUE
readonly SERVICE_TARGET="gui/$UID_VALUE/io.interagent.opencode-sara"

LOCK_HELD=0
QUIESCE_HELD=0
MAINTENANCE_ID=""
KEEP_MAINTENANCE=0
UPGRADE_STARTED=0
OLD_VERSION=""
NEW_VERSION=""

log() {
  /usr/bin/printf '%s %s\n' "$(/bin/date '+%Y-%m-%dT%H:%M:%S%z')" "$*"
}

# Invoked by the EXIT trap through cleanup.
# shellcheck disable=SC2329
close_maintenance() {
  local http_code
  [[ -n "$MAINTENANCE_ID" ]] || return 0
  http_code="$(/usr/bin/curl --noproxy '*' --silent --show-error --connect-timeout 3 --max-time 10 \
    -o /dev/null -w '%{http_code}' -X DELETE "$SKYNET_MAINTENANCE_URL/$MAINTENANCE_ID" 2>/dev/null || true)"
  if [[ "$http_code" == "204" ]]; then
    log "Skynet maintenance $MAINTENANCE_ID closed"
  else
    log "WARNING Skynet maintenance $MAINTENANCE_ID close failed http=${http_code:-curl-error}" >&2
  fi
  MAINTENANCE_ID=""
}

# shellcheck disable=SC2329
cleanup() {
  local lock_pid="" quiesce_pid=""
  if ((KEEP_MAINTENANCE == 0)); then
    close_maintenance
  elif [[ -n "$MAINTENANCE_ID" ]]; then
    log "WARNING Skynet maintenance $MAINTENANCE_ID left to expire after rollback failure" >&2
  fi
  if ((QUIESCE_HELD == 1)); then
    quiesce_pid="$(/bin/cat "$QUIESCE_FILE" 2>/dev/null || true)"
    if [[ "$quiesce_pid" == "$$" ]]; then
      /bin/rm -f -- "$QUIESCE_FILE"
    fi
  fi
  if ((LOCK_HELD == 1)); then
    lock_pid="$(/bin/cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ "$lock_pid" == "$$" ]]; then
      /bin/rm -f -- "$LOCK_FILE"
    fi
  fi
}
trap cleanup EXIT

strict_status_is_idle() {
  local status_body status_result=0
  if ! status_body="$(/usr/bin/curl --noproxy '*' --fail --silent --show-error --connect-timeout 2 --max-time 5 \
    --get --data-urlencode "directory=$OPENCODE_DIRECTORY" "$STATUS_URL" 2>/dev/null)"; then
    STATUS_FAILURE_REASON="session status request failed"
    return 1
  fi

  /usr/bin/printf '%s' "$status_body" | "$NODE_BIN" "$HELPER" status || status_result=$?
  if ((status_result == 10)); then
    STATUS_FAILURE_REASON="busy session present"
    return 1
  fi
  if ((status_result != 0)); then
    STATUS_FAILURE_REASON="invalid or unknown session status payload"
    return 1
  fi
  STATUS_FAILURE_REASON=""
  return 0
}

# In service mode the engine may be the shared background service Desktop
# started (possibly an older CLI), so "which CLI folder we point at" and "which
# version answers /remote-health" are legitimately different. The gate is
# therefore: healthy upstream + FDA probe; the expected version is only logged.
runtime_matches() {
  local expected_version="$1" health_body probe_body
  health_body="$(/usr/bin/curl --noproxy '*' --fail --silent --show-error --connect-timeout 1 --max-time 2 \
    "$HEALTH_URL" 2>/dev/null || true)"
  /usr/bin/printf '%s' "$health_body" | "$NODE_BIN" "$HELPER" health-current || return 1
  : "$expected_version"

  probe_body="$(/usr/bin/curl --noproxy '*' --fail --silent --show-error --connect-timeout 1 --max-time 2 \
    --get --data-urlencode "location[directory]=$OPENCODE_DIRECTORY" \
    "$FILE_CONTENT_URL" 2>/dev/null || true)"
  /usr/bin/printf '%s' "$probe_body" | "$NODE_BIN" "$HELPER" file-content "$FDA_PROBE_CONTENT"
}

poll_runtime() {
  local expected_version="$1"
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if runtime_matches "$expected_version"; then
      return 0
    fi
    if ((attempt < HEALTH_ATTEMPTS)); then
      /bin/sleep "$HEALTH_WAIT_SECONDS"
    fi
  done
  return 1
}

persist_update_block() {
  local block_temp
  block_temp="$(/usr/bin/mktemp "${UPDATE_BLOCK_FILE}.tmp.XXXXXX")" || return 1
  if ! /usr/bin/printf '%s\n' "automatic updates blocked after failed OpenCode update" > "$block_temp" ||
    ! /bin/chmod 0644 "$block_temp" ||
    ! /bin/mv -f "$block_temp" "$UPDATE_BLOCK_FILE"; then
    /bin/rm -f -- "$block_temp"
    return 1
  fi
}

rollback_update() {
  if /bin/cp -f "$RUN_SCRIPT_BACKUP" "$RUN_SCRIPT" &&
    /bin/launchctl kickstart -k "$SERVICE_TARGET" &&
    poll_runtime "$OLD_VERSION"; then
    log "ROLLBACK restored=$OLD_VERSION"
    return 0
  fi
  log "ROLLBACK_FAILED old_version=$OLD_VERSION new_version=$NEW_VERSION" >&2
  return 1
}

# The CLI path line inside run-opencode-sara.sh, e.g.
#   OPENCODE_CLI_PATH="/Users/kevin/Library/Application Support/ai.opencode.desktop/cli/2.0.11/opencode-cli" \
current_cli_version() {
  /usr/bin/sed -nE 's|^[[:space:]]*OPENCODE_CLI_PATH=".*/cli/([^/"]+)/opencode-cli".*$|\1|p' "$RUN_SCRIPT" | /usr/bin/head -n 1
}

point_run_script_at() {
  local version="$1" tmp
  tmp="$(/usr/bin/mktemp "${RUN_SCRIPT}.tmp.XXXXXX")" || return 1
  if ! /usr/bin/sed -E "s|(OPENCODE_CLI_PATH=\".*/cli/)[^/\"]+(/opencode-cli\")|\1${version}\2|" "$RUN_SCRIPT" > "$tmp" ||
    ! /bin/chmod 0755 "$tmp" ||
    ! /bin/mv -f "$tmp" "$RUN_SCRIPT"; then
    /bin/rm -f -- "$tmp"
    return 1
  fi
  [[ "$(current_cli_version)" == "$version" ]]
}

fail_stage() {
  local stage="$1" reason="$2"
  log "FAILED stage=$stage reason=$reason" >&2
  if ((UPGRADE_STARTED == 1)); then
    if ! persist_update_block; then
      log "WARNING failed to persist automatic update block marker" >&2
    fi
    if ! rollback_update; then
      KEEP_MAINTENANCE=1
    fi
  fi
  exit 1
}

[[ -x "$NODE_BIN" ]] || fail_stage PREFLIGHT "node missing"
[[ -d "$DESKTOP_CLI_ROOT" ]] || fail_stage PREFLIGHT "Desktop CLI folder missing"
[[ -f "$RUN_SCRIPT" ]] || fail_stage PREFLIGHT "run-opencode-sara.sh missing"
[[ -f "$HELPER" ]] || fail_stage PREFLIGHT "JSON helper missing"

if ! /usr/bin/shlock -f "$LOCK_FILE" -p "$$"; then
  log "DEFERRED reason=updater already running"
  exit 0
fi
LOCK_HELD=1

if [[ -e "$UPDATE_BLOCK_FILE" ]]; then
  log "DEFERRED reason=automatic updates blocked after prior failure; run deploy-local.sh manually"
  exit 0
fi

current_version="$(current_cli_version)"
[[ -n "$current_version" ]] || fail_stage PREFLIGHT "OPENCODE_CLI_PATH in run-opencode-sara.sh is not a Desktop cli/<version> path"
current_cli="$DESKTOP_CLI_ROOT/$current_version/opencode-cli"

# Desktop may have removed the folder the service points at (it prunes old
# versions after updating itself). Then the service cannot restart at all, so
# skip the health/idle gates and move to the newest folder right away.
if [[ -x "$current_cli" ]]; then
  current_missing=0
else
  current_missing=1
  log "WARNING current Desktop CLI $current_version is gone; forcing update"
fi

newest_result=0
newest_version="$(/bin/ls -1 "$DESKTOP_CLI_ROOT" 2>/dev/null | "$NODE_BIN" "$HELPER" desktop-cli-newest "$current_version")" || newest_result=$?
if ((newest_result == 11)); then
  fail_stage DETECT "no Desktop CLI versions found under $DESKTOP_CLI_ROOT"
fi
if ((newest_result == 1)) && ((current_missing == 0)); then
  log "No OpenCode update available (Desktop CLI $current_version)"
  exit 0
fi
[[ -x "$DESKTOP_CLI_ROOT/$newest_version/opencode-cli" ]] || fail_stage DETECT "Desktop CLI $newest_version has no executable"
OLD_VERSION="$current_version"
NEW_VERSION="$newest_version"

if ((current_missing == 0)); then
  if ! runtime_matches "$current_version"; then
    log "DEFERRED reason=current remote health or FDA probe unavailable"
    exit 0
  fi

  STATUS_FAILURE_REASON=""
  if ! strict_status_is_idle; then
    log "DEFERRED reason=$STATUS_FAILURE_REASON"
    exit 0
  fi
fi

if ! (set -o noclobber; /usr/bin/printf '%s\n' "$$" > "$QUIESCE_FILE") 2>/dev/null; then
  log "DEFERRED reason=update quiesce already owned"
  exit 0
fi
QUIESCE_HELD=1
/bin/sleep 1

if ((current_missing == 0)) && ! strict_status_is_idle; then
  log "DEFERRED reason=$STATUS_FAILURE_REASON after quiesce"
  exit 0
fi

maintenance_response="$(/usr/bin/curl --noproxy '*' --silent --show-error --connect-timeout 3 --max-time 10 \
  -w '\n%{http_code}' -X POST "$SKYNET_MAINTENANCE_URL" \
  -H 'Content-Type: application/json' \
  -d '{"scope":"all","durationMinutes":10,"reason":"upgrade opencode-sara"}' 2>/dev/null || true)"
maintenance_http_code="${maintenance_response##*$'\n'}"
maintenance_body="${maintenance_response%$'\n'*}"
if [[ "$maintenance_http_code" == "201" ]]; then
  MAINTENANCE_ID="$(/usr/bin/printf '%s' "$maintenance_body" | "$NODE_BIN" "$HELPER" maintenance-id 2>/dev/null || true)"
fi
if [[ -n "$MAINTENANCE_ID" ]]; then
  log "Skynet maintenance $MAINTENANCE_ID opened"
else
  log "WARNING Skynet maintenance not confirmed; continuing best-effort http=${maintenance_http_code:-curl-error}" >&2
fi

log "Switching opencode-sara to Desktop CLI $NEW_VERSION (was $OLD_VERSION)"
/bin/cp -f "$RUN_SCRIPT" "$RUN_SCRIPT_BACKUP" || fail_stage UPGRADE "could not back up run-opencode-sara.sh"
UPGRADE_STARTED=1
point_run_script_at "$NEW_VERSION" || fail_stage UPGRADE "could not rewrite OPENCODE_CLI_PATH"
new_version="$NEW_VERSION"

if ! /bin/launchctl kickstart -k "$SERVICE_TARGET"; then
  fail_stage RESTART "launchctl kickstart failed"
fi

if poll_runtime "$new_version"; then
  log "UPDATED opencode=$new_version health=healthy fda_probe=verified"
  exit 0
fi

fail_stage HEALTH "remote health and FDA probe did not recover for opencode $new_version"
