#!/bin/bash
# Deploy opencode-remote to the three hosts and verify each one.
# Usage: deploy/deploy-all.sh [--dry-run] [--allow-dirty] [--check] <sara|l390|home|all>
# "all" order: home -> l390 -> sara (sara last: it hosts this control machine).
# --dry-run: print every command without connecting or executing.
# --check: read-only check only (ssh echo, remote path probe, current
#   /remote-health build + version on all three hosts). No deploy, no restart.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRY_RUN=0
ALLOW_DIRTY=0
CHECK=0
TARGET=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --check) CHECK=1 ;;
    sara|l390|home|all) TARGET="$arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "usage: deploy/deploy-all.sh [--dry-run] [--allow-dirty] [--check] <sara|l390|home|all>" >&2
  exit 2
fi

if [[ "$DRY_RUN" -eq 1 && "$CHECK" -eq 1 ]]; then
  echo "refusing: --dry-run and --check are mutually exclusive" >&2
  exit 2
fi

# The FDA probe file remote services create in their workspace.
# Must match deploy/macos/deploy-local.sh (FDA_PROBE_DIR/FILE) and
# deploy/windows/opencode-remote-runtime.psm1 (Ensure-OpenCodeRemoteProbe).
FDA_RELATIVE=".opencode-remote/remote-fda-probe.txt"
FDA_CONTENT="opencode-remote FDA probe v1"

# Dedicated staging dir in the remote user's home. Windows OpenSSH maps
#   ssh l390:opencode-remote-deploy/...  ->  C:\Users\Kevin\opencode-remote-deploy\...
# Never use /tmp on Windows remotes: it is not C:\Windows\Temp there.
L390_SSH=(ssh l390-ts)
L390_HOME="C:\\Users\\Kevin"
L390_STAGE_DIR="opencode-remote-deploy"
L390_STAGE_WIN="$L390_HOME\\$L390_STAGE_DIR"
L390_REPO_WIN="C:\\Users\\Kevin\\opencode-remote"
HOME_SSH=(ssh -i "$HOME/.ssh/id_mesh_ed25519" -o IdentitiesOnly=yes kevin@100.83.112.20)
HOME_USER="kevin@100.83.112.20"
HOME_SCP=(scp -i "$HOME/.ssh/id_mesh_ed25519" -o IdentitiesOnly=yes)
HOME_STAGE_DIR="opencode-remote-deploy"
HOME_STAGE_WIN="C:\\Users\\Kevin\\$HOME_STAGE_DIR"
HOME_REPO_WIN="D:\\GitClone\\_HomeProject\\opencode-remote"

# --- preflight: local HEAD must be pushed (home deploys via git pull) ---
if [[ "$CHECK" -eq 0 ]]; then
  if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
      echo "refusing: working tree is dirty (use --allow-dirty to override)" >&2
      exit 1
    fi
  fi
  ahead="$(git -C "$REPO_ROOT" status -sb | head -1)"
  if [[ "$ahead" == *"ahead"* ]]; then
    echo "refusing: local HEAD is ahead of origin ($ahead); push first" >&2
    exit 1
  fi
fi

# --- preflight: tests pass ---
if [[ "$CHECK" -eq 1 ]]; then
  :
elif [[ "$DRY_RUN" -eq 1 ]]; then
  echo "would run: (cd $REPO_ROOT && npm test)"
else
  (cd "$REPO_ROOT" && npm test)
fi

HEAD_SHORT="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"

run_or_print() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'would run:'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# Fetch and parse one host's /remote-health into shell vars:
#   HEALTH_COMMIT HEALTH_HEALTHY(yes/no) HEALTH_VERSION.
read_remote_health() {
  local host="$1"
  local body
  body="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 "https://$host/remote-health" 2>/dev/null || true)"
  HEALTH_COMMIT="$(printf '%s' "$body" | /opt/homebrew/bin/node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).build?.commit??'')}catch{}})" 2>/dev/null || true)"
  HEALTH_HEALTHY="$(printf '%s' "$body" | /opt/homebrew/bin/node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).upstreamHealth?.healthy===true?'yes':'no')}catch{console.log('no')}})" 2>/dev/null || true)"
  HEALTH_VERSION="$(printf '%s' "$body" | /opt/homebrew/bin/node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).upstreamHealth?.version??'')}catch{}})" 2>/dev/null || true)"
}

# Same file probe deploy/macos/deploy-local.sh uses: the proxy forwards
# /api/fs/read/<relative>?location[directory]=<workspace> to upstream, which
# answers with the raw file body. Expect the exact probe text back.
fda_probe_host() {
  local host="$1" workspace="$2"
  local encoded_workspace body
  encoded_workspace="$(printf '%s' "$workspace" | /opt/homebrew/bin/node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(encodeURIComponent(d)))")"
  body="$(curl --fail --silent --show-error --connect-timeout 3 --max-time 5 \
    "https://$host/api/fs/read/$FDA_RELATIVE?location%5Bdirectory%5D=$encoded_workspace" 2>/dev/null || true)"
  # Trim trailing newline/carriage-return like the Windows runtime check does.
  body="$(printf '%s' "$body" | tr -d '\r\n' | sed 's/[[:space:]]*$//')"
  if [[ "$body" == "$FDA_CONTENT" ]]; then
    echo "FDA probe OK $host"
    return 0
  fi
  echo "FAIL $host: FDA probe mismatch (got ${#body} bytes)" >&2
  return 1
}

# Poll https://<host>/remote-health until build.commit == HEAD_SHORT
# and upstreamHealth.healthy == true (max ~90s), then run the FDA probe
# and print the OK line.
wait_for_host() {
  local name="$1" host="$2" workspace="$3"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "would run: poll https://$host/remote-health until build.commit == $HEAD_SHORT and upstreamHealth.healthy == true (90s max)"
    echo "would run: FDA probe https://$host/api/fs/read/$FDA_RELATIVE?location[directory]=$workspace"
    echo "OK $name $HEAD_SHORT upstream=<version> (dry-run)"
    return 0
  fi
  local attempt
  for ((attempt = 1; attempt <= 45; attempt++)); do
    read_remote_health "$host"
    if [[ "$HEALTH_COMMIT" == "$HEAD_SHORT" && "$HEALTH_HEALTHY" == "yes" ]]; then
      echo "OK $name $HEALTH_COMMIT upstream=$HEALTH_VERSION"
      fda_probe_host "$host" "$workspace" || return 1
      return 0
    fi
    sleep 2
  done
  echo "FAIL $name: build.commit did not become $HEAD_SHORT with healthy upstream within 90s" >&2
  return 1
}

deploy_sara() {
  # sara workspace is the Mac checkout; FDA probe path mirrors
  # deploy-local.sh FDA_PROBE_FILE ($WORKSPACE/.opencode-remote/remote-fda-probe.txt).
  local workspace="/Users/kevin/Documents/Projects"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "would run: OPENCODE_REMOTE_BUILD_COMMIT=$HEAD_SHORT $REPO_ROOT/deploy/macos/deploy-local.sh"
  else
    (cd "$REPO_ROOT" && OPENCODE_REMOTE_BUILD_COMMIT="$HEAD_SHORT" deploy/macos/deploy-local.sh)
  fi
  wait_for_host sara opencode-sara.sisihome.org "$workspace"
}

# l390: not a git clone. Pack HEAD, unpack over the remote repo
# (keeping remote .env and node_modules), rebuild with the commit baked
# into build-info.json, restart.
deploy_l390() {
  local archive="/tmp/opencode-remote-l390.tar.gz"
  local workspace="C:/Users/Kevin"
  run_or_print git -C "$REPO_ROOT" archive -o "$archive" HEAD
  run_or_print "${L390_SSH[@]}" "mkdir $L390_STAGE_DIR 2>nul & exit 0"
  run_or_print scp "$archive" "l390-ts:$L390_STAGE_DIR/opencode-remote-l390.tar.gz"
  run_or_print "${L390_SSH[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"if (Test-Path $L390_REPO_WIN\\.env) { Copy-Item $L390_REPO_WIN\\.env $L390_STAGE_WIN\\oc-remote.env.bak -Force }\""
  run_or_print "${L390_SSH[@]}" "cmd /c \"cd /d $L390_REPO_WIN && tar -xzf $L390_STAGE_WIN\\opencode-remote-l390.tar.gz\""
  run_or_print scp "$REPO_ROOT/deploy/windows/restart-l390.ps1" "l390-ts:$L390_STAGE_DIR/restart-l390.ps1"
  run_or_print "${L390_SSH[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -File $L390_STAGE_WIN\\restart-l390.ps1 -Commit $HEAD_SHORT"
  wait_for_host l390 opencode-l390.sisihome.org "$workspace"
}

# home: a git clone. Pull, rebuild, restart.
# l390 connects over Tailscale as l390-ts (100.79.199.43); plain `l390`
# (office Wi-Fi 10.11.1.87) only works inside the office.
deploy_home() {
  local workspace="D:/GitClone/_HomeProject"
  run_or_print "${HOME_SSH[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"cd $HOME_REPO_WIN; git pull --ff-only\""
  run_or_print "${HOME_SSH[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"New-Item -ItemType Directory -Force $HOME_STAGE_WIN | Out-Null\""
  run_or_print "${HOME_SCP[@]}" "$REPO_ROOT/deploy/windows/restart-home.ps1" "$HOME_USER:$HOME_STAGE_DIR/restart-home.ps1"
  run_or_print "${HOME_SSH[@]}" "powershell -NoProfile -ExecutionPolicy Bypass -File $HOME_STAGE_WIN\\restart-home.ps1"
  wait_for_host home opencode-home.sisihome.org "$workspace"
}

# --- --check: read-only. ssh echo, remote path probe, current health. ---
check_host() {
  local name="$1" host="$2" repo_path="$3" path_kind="$4"
  shift 4
  echo "--- $name ($host) ---"
  "$@" "echo ssh-ok-$name"
  if [[ "$path_kind" == "win" ]]; then
    "$@" "powershell -NoProfile -ExecutionPolicy Bypass -Command \"if (Test-Path $repo_path\\packages\\server\\dist\\index.js) { 'repo-path-ok' } else { 'repo-path-MISSING' }\""
  else
    "$@" "test -f $repo_path/packages/server/dist/index.js && echo repo-path-ok || echo repo-path-MISSING"
  fi
  read_remote_health "$host"
  echo "build.commit=$HEALTH_COMMIT healthy=$HEALTH_HEALTHY upstream_version=$HEALTH_VERSION"
}

check_sara() { check_host sara opencode-sara.sisihome.org "/Users/kevin/.local/share/opencode-remote" posix bash -c; }
check_l390() { check_host l390 opencode-l390.sisihome.org "$L390_REPO_WIN" win "${L390_SSH[@]}"; }
check_home() { check_host home opencode-home.sisihome.org "$HOME_REPO_WIN" win "${HOME_SSH[@]}"; }

if [[ "$CHECK" -eq 1 ]]; then
  case "$TARGET" in
    sara) check_sara ;;
    l390) check_l390 ;;
    home) check_home ;;
    all) check_home; check_l390; check_sara ;;
  esac
  exit 0
fi

case "$TARGET" in
  sara) deploy_sara ;;
  l390) deploy_l390 ;;
  home) deploy_home ;;
  all) deploy_home; deploy_l390; deploy_sara ;;
esac
