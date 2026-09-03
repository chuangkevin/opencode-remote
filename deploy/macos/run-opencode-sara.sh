#!/bin/bash

set -euo pipefail

readonly EXPECTED_TAILSCALE_IP="100.113.121.103"
readonly TAILSCALE_BIN="/Applications/Tailscale.app/Contents/MacOS/Tailscale"
readonly NODE_BIN="/opt/homebrew/bin/node"
readonly SERVER_ENTRY="/Users/kevin/.local/share/opencode-remote/packages/server/dist/index.js"
readonly WAIT_ATTEMPTS=30
readonly WAIT_SECONDS=2

tailscale_ready() {
  local address addresses
  addresses="$("$TAILSCALE_BIN" ip -4 2>/dev/null || true)"
  while IFS= read -r address; do
    if [[ "$address" == "$EXPECTED_TAILSCALE_IP" ]]; then
      return 0
    fi
  done <<< "$addresses"
  return 1
}

for ((attempt = 1; attempt <= WAIT_ATTEMPTS; attempt++)); do
  if tailscale_ready; then
    exec /usr/bin/env -i \
      HOME="/Users/kevin" \
      USER="kevin" \
      LOGNAME="kevin" \
      SHELL="/bin/zsh" \
      PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
      TMPDIR="/tmp" \
      LANG="en_US.UTF-8" \
      OPENCODE_DIRECTORY="/Users/kevin/Documents/Projects" \
      OPENCODE_CLI_PATH="/opt/homebrew/bin/opencode" \
      PORT="9223" \
      OPENCODE_PORT="4196" \
      BIND_ADDRESS="$EXPECTED_TAILSCALE_IP" \
      "$NODE_BIN" "$SERVER_ENTRY"
  fi

  if ((attempt < WAIT_ATTEMPTS)); then
    /bin/sleep "$WAIT_SECONDS"
  fi
done

echo "Expected Tailscale IPv4 $EXPECTED_TAILSCALE_IP was unavailable after $((WAIT_ATTEMPTS * WAIT_SECONDS)) seconds." >&2
exit 1
