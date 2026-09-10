#!/bin/bash

set -euo pipefail

readonly EXPECTED_USER="kevin"
readonly EXPECTED_TAILSCALE_IP="100.113.121.103"
readonly NODE_BIN="/opt/homebrew/bin/node"
readonly NPM_BIN="/opt/homebrew/bin/npm"
readonly BREW_BIN="/opt/homebrew/bin/brew"
readonly OPENCODE_BIN="/opt/homebrew/bin/opencode"
readonly TAILSCALE_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
readonly WORKSPACE="/Users/kevin/Documents/Projects"
readonly RUNTIME_DIR="/Users/kevin/.local/share/opencode-remote"
readonly RUNTIME_PARENT="/Users/kevin/.local/share"
readonly LOG_DIR="/Users/kevin/Library/Logs/opencode-remote"
readonly PLIST_SOURCE_NAME="io.interagent.opencode-sara.plist"
readonly PLIST_DEST="/Users/kevin/Library/LaunchAgents/$PLIST_SOURCE_NAME"
readonly LABEL="io.interagent.opencode-sara"
readonly UPDATER_SOURCE_NAME="update-opencode-sara.sh"
readonly UPDATER_HELPER_SOURCE_NAME="update-opencode-sara-json.mjs"
readonly UPDATER_PLIST_SOURCE_NAME="io.interagent.opencode-sara-updater.plist"
readonly UPDATER_DEST="$RUNTIME_DIR/$UPDATER_SOURCE_NAME"
readonly UPDATER_HELPER_DEST="$RUNTIME_DIR/$UPDATER_HELPER_SOURCE_NAME"
readonly UPDATER_PLIST_DEST="/Users/kevin/Library/LaunchAgents/$UPDATER_PLIST_SOURCE_NAME"
readonly UPDATER_LABEL="io.interagent.opencode-sara-updater"
readonly HEALTH_URL="http://100.113.121.103:9223/remote-health"
readonly FILE_CONTENT_URL="http://100.113.121.103:9223/file/content"
readonly FDA_PROBE_DIR="$WORKSPACE/.opencode-remote"
readonly FDA_PROBE_FILE="$FDA_PROBE_DIR/remote-fda-probe.txt"
readonly FDA_PROBE_CONTENT="opencode-remote FDA probe v1"
readonly UPDATE_BLOCK_FILE="$RUNTIME_DIR/update-opencode-sara.blocked"
readonly HEALTH_ATTEMPTS=30
readonly HEALTH_WAIT_SECONDS=2
readonly STOP_ATTEMPTS=15
readonly STOP_WAIT_SECONDS=1
readonly SERVER_ENTRY="$RUNTIME_DIR/packages/server/dist/index.js"
readonly PLUGIN_SOURCE_NAME="opencode-remote-desktop-bridge.js"
readonly PLUGIN_DIR="/Users/kevin/.config/opencode/plugins"
readonly PLUGIN_DEST="$PLUGIN_DIR/$PLUGIN_SOURCE_NAME"
readonly BRIDGE_LIB_SOURCE_NAME="opencode-remote-desktop-bridge-lib.js"
readonly BRIDGE_LIB_DIR="/Users/kevin/.config/opencode/opencode-remote"
readonly BRIDGE_LIB_DEST="$BRIDGE_LIB_DIR/$BRIDGE_LIB_SOURCE_NAME"
readonly BRIDGE_LIB_PACKAGE_DEST="$BRIDGE_LIB_DIR/package.json"
readonly BUILD_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly BRIDGE_LIB_SOURCE="$SCRIPT_DIR/../opencode-remote/$BRIDGE_LIB_SOURCE_NAME"
readonly BRIDGE_LIB_PACKAGE_SOURCE="$SCRIPT_DIR/../opencode-remote/package.json"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STAGE_ARCHIVE=""
PROBE_TEMP=""

cleanup() {
  if [[ -n "$STAGE_ARCHIVE" && -f "$STAGE_ARCHIVE" ]]; then
    /bin/rm -f -- "$STAGE_ARCHIVE"
  fi
  if [[ -n "$PROBE_TEMP" && -f "$PROBE_TEMP" ]]; then
    /bin/rm -f -- "$PROBE_TEMP"
  fi
}
trap cleanup EXIT

fail() {
  echo "deploy-local.sh: $*" >&2
  exit 1
}

require_executable() {
  [[ -x "$1" ]] || fail "required executable is missing: $1"
}

[[ "$(/usr/bin/uname -s)" == "Darwin" ]] || fail "this installer only supports macOS"
[[ "$(/usr/bin/id -un)" == "$EXPECTED_USER" ]] || fail "run as user $EXPECTED_USER without sudo"
[[ -d "$WORKSPACE" ]] || fail "workspace is missing: $WORKSPACE"
[[ -f "$REPO_ROOT/package-lock.json" ]] || fail "run from the opencode-remote repository"
[[ -f "$SCRIPT_DIR/run-opencode-sara.sh" ]] || fail "runtime wrapper is missing"
[[ -f "$SCRIPT_DIR/$PLIST_SOURCE_NAME" ]] || fail "LaunchAgent plist is missing"
[[ -f "$SCRIPT_DIR/$UPDATER_SOURCE_NAME" ]] || fail "updater script is missing"
[[ -f "$SCRIPT_DIR/$UPDATER_HELPER_SOURCE_NAME" ]] || fail "updater JSON helper is missing"
[[ -f "$SCRIPT_DIR/$UPDATER_PLIST_SOURCE_NAME" ]] || fail "updater LaunchAgent plist is missing"
[[ -f "$SCRIPT_DIR/$PLUGIN_SOURCE_NAME" ]] || fail "Desktop status bridge plugin is missing"
[[ -f "$BRIDGE_LIB_SOURCE" ]] || fail "Desktop status bridge library is missing"
[[ -f "$BRIDGE_LIB_PACKAGE_SOURCE" ]] || fail "Desktop status bridge library package metadata is missing"

require_executable "$NODE_BIN"
require_executable "$NPM_BIN"
require_executable "$BREW_BIN"
require_executable "$OPENCODE_BIN"
require_executable "$TAILSCALE_BIN"
require_executable "/usr/bin/curl"
require_executable "/bin/launchctl"
require_executable "/usr/bin/plutil"
require_executable "/usr/bin/tar"
require_executable "/usr/sbin/lsof"
require_executable "/usr/bin/shlock"

health_response_is_expected() {
  /usr/bin/printf '%s' "$1" | "$NODE_BIN" "$SCRIPT_DIR/$UPDATER_HELPER_SOURCE_NAME" deploy-health
}

fda_probe_response_is_expected() {
  /usr/bin/printf '%s' "$1" | "$NODE_BIN" "$SCRIPT_DIR/$UPDATER_HELPER_SOURCE_NAME" file-content "$FDA_PROBE_CONTENT"
}

running_service_pid() {
  local service_info line service_state="" service_pid=""

  service_info="$(/bin/launchctl print "$SERVICE_TARGET" 2>/dev/null)" || return 1
  while IFS= read -r line; do
    if [[ -z "$service_state" && "$line" =~ ^[[:space:]]*state[[:space:]]*=[[:space:]]*([^[:space:]]+)[[:space:]]*$ ]]; then
      service_state="${BASH_REMATCH[1]}"
    elif [[ -z "$service_pid" && "$line" =~ ^[[:space:]]*pid[[:space:]]*=[[:space:]]*([0-9]+)[[:space:]]*$ ]]; then
      service_pid="${BASH_REMATCH[1]}"
    fi
  done <<< "$service_info"

  [[ "$service_state" == "running" && "$service_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  /usr/bin/printf '%s\n' "$service_pid"
}

exact_listener_pid() {
  local address="$1" port="$2" lsof_output line current_pid="" listener_name="" found_pid=""

  lsof_output="$(/usr/sbin/lsof -nP -a -iTCP@"$address":"$port" -sTCP:LISTEN -Fpn 2>/dev/null || true)"
  while IFS= read -r line; do
    case "$line" in
      p*) current_pid="${line#p}" ;;
      n*)
        listener_name="${line#n}"
        if [[ "$listener_name" == "$address:$port" && "$current_pid" =~ ^[1-9][0-9]*$ ]]; then
          if [[ -n "$found_pid" && "$found_pid" != "$current_pid" ]]; then
            return 1
          fi
          found_pid="$current_pid"
        fi
        ;;
    esac
  done <<< "$lsof_output"

  [[ -n "$found_pid" ]] || return 1
  /usr/bin/printf '%s\n' "$found_pid"
}

exact_listener_exists() {
  local address="$1" port="$2" lsof_output line

  lsof_output="$(/usr/sbin/lsof -nP -a -iTCP@"$address":"$port" -sTCP:LISTEN -Fn 2>/dev/null || true)"
  while IFS= read -r line; do
    [[ "$line" == "n$address:$port" ]] && return 0
  done <<< "$lsof_output"
  return 1
}

pid_command_is() {
  local pid="$1" expected="$2" command

  command="$(/bin/ps -ww -p "$pid" -o command= 2>/dev/null)" || return 1
  [[ "$command" == "$expected" ]]
}

pid_parent_is() {
  local pid="$1" expected_parent="$2" parent

  parent="$(/bin/ps -p "$pid" -o ppid= 2>/dev/null)" || return 1
  parent="${parent//[[:space:]]/}"
  [[ "$parent" == "$expected_parent" ]]
}

expected_listeners_are_absent() {
  ! exact_listener_exists "$EXPECTED_TAILSCALE_IP" 9223 &&
    ! exact_listener_exists "127.0.0.1" 4196
}

runtime_process_tree_is_expected() {
  local service_pid="$1" proxy_pid opencode_pid

  proxy_pid="$(exact_listener_pid "$EXPECTED_TAILSCALE_IP" 9223)" || return 1
  opencode_pid="$(exact_listener_pid "127.0.0.1" 4196)" || return 1
  [[ "$service_pid" == "$proxy_pid" ]] || return 1
  pid_command_is "$service_pid" "$NODE_BIN $SERVER_ENTRY" || return 1
  pid_command_is "$opencode_pid" "$OPENCODE_BIN serve --hostname 127.0.0.1 --port 4196" || return 1
  pid_parent_is "$opencode_pid" "$service_pid"
}

node_major="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
((node_major >= 22)) || fail "Node.js 22 or newer is required; found $("$NODE_BIN" --version)"
"$OPENCODE_BIN" --version >/dev/null
/bin/bash -n "$SCRIPT_DIR/$UPDATER_SOURCE_NAME"
"$NODE_BIN" --check "$SCRIPT_DIR/$UPDATER_HELPER_SOURCE_NAME"
/usr/bin/plutil -lint "$SCRIPT_DIR/$PLIST_SOURCE_NAME" >/dev/null
/usr/bin/plutil -lint "$SCRIPT_DIR/$UPDATER_PLIST_SOURCE_NAME" >/dev/null

echo "Installing dependencies from package-lock.json..."
(cd "$REPO_ROOT" && PATH="$BUILD_PATH" "$NPM_BIN" ci)

echo "Running typecheck..."
(cd "$REPO_ROOT" && PATH="$BUILD_PATH" "$NPM_BIN" run typecheck)

echo "Building runtime..."
(cd "$REPO_ROOT" && PATH="$BUILD_PATH" "$NPM_BIN" run build)

[[ -f "$REPO_ROOT/packages/server/dist/index.js" ]] || fail "build did not create packages/server/dist/index.js"
[[ -d "$REPO_ROOT/packages/server/static" ]] || fail "compact static assets are missing"
[[ -f "$REPO_ROOT/mockups/compact-mockup.html" ]] || fail "runtime compact mockup is missing"

/usr/bin/install -d -m 0755 "$RUNTIME_PARENT" "$RUNTIME_DIR" "$LOG_DIR" "$(/usr/bin/dirname "$PLIST_DEST")"
STAGE_ARCHIVE="$(/usr/bin/mktemp "$RUNTIME_PARENT/.opencode-remote-runtime.tar.XXXXXX")"
GUI_DOMAIN="gui/$(/usr/bin/id -u)"
readonly GUI_DOMAIN
readonly SERVICE_TARGET="$GUI_DOMAIN/$LABEL"
readonly UPDATER_TARGET="$GUI_DOMAIN/$UPDATER_LABEL"

echo "Staging runtime allowlist..."
(cd "$REPO_ROOT" && /usr/bin/tar -cf "$STAGE_ARCHIVE" \
  packages/server/package.json \
  packages/server/dist/config.js \
  packages/server/dist/index.js \
  packages/server/dist/opencode-command.js \
  packages/server/dist/session.js \
  packages/server/dist/update-quiesce.js \
  packages/server/dist/compact/handlers.js \
  packages/server/dist/compact/model.js \
  packages/server/dist/compact/pins.js \
  packages/server/dist/compact/session-status.js \
  packages/server/dist/compact/shell.js \
  packages/server/dist/compact/trust.js \
  packages/server/static \
  mockups/compact-mockup.html)

echo "Verifying runtime allowlist covers every relative import..."
/usr/bin/python3 - "$STAGE_ARCHIVE" "$REPO_ROOT/packages/server/dist" <<'PYEOF' || fail "runtime allowlist is missing a module imported by the build; add it to the tar list above"
import pathlib, re, subprocess, sys

archive, dist_dir = sys.argv[1], pathlib.Path(sys.argv[2]).resolve()
packed = set(subprocess.run(["/usr/bin/tar", "-tf", archive],
                            capture_output=True, text=True, check=True).stdout.split())
missing = []
for js in dist_dir.rglob("*.js"):
    body = js.read_text(encoding="utf-8", errors="replace")
    for spec in re.findall(r'from\s+"(\.{1,2}/[^"]+)"', body):
        target = (js.parent / spec).resolve()
        rel = "packages/server/dist/" + target.relative_to(dist_dir).as_posix()
        if rel not in packed:
            missing.append("%s imports %s -> %s not packed"
                           % (js.relative_to(dist_dir), spec, rel))
for line in missing:
    print("  MISSING:", line, file=sys.stderr)
sys.exit(1 if missing else 0)
PYEOF

if /bin/launchctl print "$UPDATER_TARGET" >/dev/null 2>&1; then
  echo "Stopping exact updater LaunchAgent for deployment..."
  /bin/launchctl bootout "$UPDATER_TARGET"
fi

if /bin/launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
  echo "Stopping existing LaunchAgent..."
  /bin/launchctl bootout "$SERVICE_TARGET"
fi

echo "Waiting for exact service listeners to close..."
for ((attempt = 1; attempt <= STOP_ATTEMPTS; attempt++)); do
  if expected_listeners_are_absent; then
    break
  fi
  if ((attempt == STOP_ATTEMPTS)); then
    fail "exact listeners remained after LaunchAgent bootout; refusing bootstrap without killing unrelated processes"
  fi
  /bin/sleep "$STOP_WAIT_SECONDS"
done

echo "Updating runtime copy without deleting service data..."
/usr/bin/tar -xf "$STAGE_ARCHIVE" -C "$RUNTIME_DIR"
/bin/rm -f -- "$RUNTIME_DIR/launch-opencode-sara.sh"
/usr/bin/install -m 0755 "$SCRIPT_DIR/run-opencode-sara.sh" "$RUNTIME_DIR/run-opencode-sara.sh"
/usr/bin/install -m 0644 "$SCRIPT_DIR/$PLIST_SOURCE_NAME" "$PLIST_DEST"
/usr/bin/install -d -m 0700 "$PLUGIN_DIR" "$BRIDGE_LIB_DIR"
/usr/bin/install -m 0600 "$SCRIPT_DIR/$PLUGIN_SOURCE_NAME" "$PLUGIN_DEST"
/usr/bin/install -m 0600 "$BRIDGE_LIB_SOURCE" "$BRIDGE_LIB_DEST"
/usr/bin/install -m 0600 "$BRIDGE_LIB_PACKAGE_SOURCE" "$BRIDGE_LIB_PACKAGE_DEST"

echo "Installing fixed Full Disk Access probe without replacing shared workspace state..."
if [[ ! -e "$FDA_PROBE_DIR" ]]; then
  /bin/mkdir -m 0755 "$FDA_PROBE_DIR"
fi
[[ -d "$FDA_PROBE_DIR" && ! -L "$FDA_PROBE_DIR" ]] || fail "FDA probe parent must be an existing real directory: $FDA_PROBE_DIR"
PROBE_TEMP="$(/usr/bin/mktemp "$FDA_PROBE_DIR/.remote-fda-probe.txt.XXXXXX")"
/usr/bin/printf '%s' "$FDA_PROBE_CONTENT" > "$PROBE_TEMP"
/bin/chmod 0644 "$PROBE_TEMP"
/bin/mv -f "$PROBE_TEMP" "$FDA_PROBE_FILE"
PROBE_TEMP=""

echo "Loading LaunchAgent..."
/bin/launchctl bootstrap "$GUI_DOMAIN" "$PLIST_DEST"
/bin/launchctl kickstart "$SERVICE_TARGET"

echo "Waiting for $HEALTH_URL..."
healthy_service_pid=""
for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
  health_body="$(/usr/bin/curl --noproxy '*' --fail --silent --show-error --connect-timeout 1 --max-time 2 "$HEALTH_URL" 2>/dev/null || true)"
  if health_response_is_expected "$health_body"; then
    if service_pid="$(running_service_pid)" && runtime_process_tree_is_expected "$service_pid"; then
      probe_body="$(/usr/bin/curl --noproxy '*' --fail --silent --show-error --connect-timeout 1 --max-time 2 \
        --get --data-urlencode "path=$FDA_PROBE_FILE" --data-urlencode "directory=$WORKSPACE" \
        "$FILE_CONTENT_URL" 2>/dev/null || true)"
      if fda_probe_response_is_expected "$probe_body"; then
        echo "OpenCode Remote is healthy with verified FDA access at $EXPECTED_TAILSCALE_IP:9223 (LaunchAgent Node PID $service_pid)."
        healthy_service_pid="$service_pid"
        break
      fi
    fi
  fi

  if ((attempt < HEALTH_ATTEMPTS)); then
    /bin/sleep "$HEALTH_WAIT_SECONDS"
  fi
done

[[ -n "$healthy_service_pid" ]] || fail "health check did not confirm the expected JSON, FDA probe, LaunchAgent Node PID, exact listeners, and runtime process tree after $HEALTH_ATTEMPTS attempts; inspect $LOG_DIR"

echo "Installing idle-only OpenCode updater after the main service health gate..."
/usr/bin/install -m 0755 "$SCRIPT_DIR/$UPDATER_SOURCE_NAME" "$UPDATER_DEST"
/usr/bin/install -m 0644 "$SCRIPT_DIR/$UPDATER_HELPER_SOURCE_NAME" "$UPDATER_HELPER_DEST"
/usr/bin/install -m 0644 "$SCRIPT_DIR/$UPDATER_PLIST_SOURCE_NAME" "$UPDATER_PLIST_DEST"
/bin/rm -f -- "$UPDATE_BLOCK_FILE"
/bin/launchctl bootstrap "$GUI_DOMAIN" "$UPDATER_PLIST_DEST"

echo "OpenCode Remote deployment and updater installation completed."
