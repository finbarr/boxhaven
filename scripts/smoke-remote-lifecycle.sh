#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

bh_bin="${BOXHAVEN_SMOKE_BH:-${repo_root}/bh}"
backend_url="${BOXHAVEN_SMOKE_BACKEND_URL:-${BOXHAVEN_BACKEND_URL:-https://api.boxhaven.dev}}"
tier="${BOXHAVEN_SMOKE_TIER:-small}"
keep="${BOXHAVEN_SMOKE_KEEP:-0}"
require_preview="${BOXHAVEN_SMOKE_REQUIRE_PREVIEW:-1}"
git_remote="${BOXHAVEN_SMOKE_GIT_REMOTE:-}"
restart_backend_cmd="${BOXHAVEN_SMOKE_RESTART_BACKEND_CMD:-}"
agent_reconnect_sleep="${BOXHAVEN_SMOKE_AGENT_RECONNECT_SLEEP:-20}"
production_mode="${BOXHAVEN_SMOKE_PRODUCTION:-0}"

raw_prefix="${BOXHAVEN_SMOKE_PREFIX:-smoke-$(date -u +%H%M%S)}"
prefix="$(printf "%s" "$raw_prefix" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed -E 's/^-+//; s/-+$//; s/-+/-/g' | cut -c1-48)"
if [ -z "$prefix" ]; then
  prefix="smoke"
fi

boxes=("${prefix}-a" "${prefix}-b")
created=()
project_dir=""

log() {
  printf '==> %s\n' "$*" >&2
}

cleanup() {
  status=$?
  if [ "$keep" != "1" ]; then
    for name in "${created[@]}"; do
      log "destroying ${name}"
      (cd "$project_dir" && BOXHAVEN_BACKEND_URL="$backend_url" "$bh_bin" destroy "$name") || true
    done
  else
    log "BOXHAVEN_SMOKE_KEEP=1, leaving boxes: ${created[*]:-(none)}"
  fi
  if [ -n "$project_dir" ]; then
    rm -rf "$project_dir"
  fi
  exit "$status"
}
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 1
  }
}

preflight() {
  if [ "$production_mode" != "1" ]; then
    return
  fi
  [ -n "${BOXHAVEN_TOKEN:-}" ] || {
    printf 'BOXHAVEN_SMOKE_PRODUCTION=1 requires BOXHAVEN_TOKEN\n' >&2
    exit 2
  }
  [ -n "$git_remote" ] || {
    printf 'BOXHAVEN_SMOKE_PRODUCTION=1 requires BOXHAVEN_SMOKE_GIT_REMOTE\n' >&2
    exit 2
  }
  [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ] || {
    printf 'BOXHAVEN_SMOKE_PRODUCTION=1 requires GH_TOKEN or GITHUB_TOKEN\n' >&2
    exit 2
  }
  [ -n "$restart_backend_cmd" ] || {
    printf 'BOXHAVEN_SMOKE_PRODUCTION=1 requires BOXHAVEN_SMOKE_RESTART_BACKEND_CMD\n' >&2
    exit 2
  }
  [ "$require_preview" = "1" ] || {
    printf 'BOXHAVEN_SMOKE_PRODUCTION=1 requires BOXHAVEN_SMOKE_REQUIRE_PREVIEW=1\n' >&2
    exit 2
  }
}

ensure_bh() {
  if [ -x "$bh_bin" ]; then
    return
  fi
  log "building bh"
  make -C "$repo_root" build
}

init_project() {
  project_dir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-smoke.XXXXXX")"
  log "creating smoke project at ${project_dir}"
  git -C "$project_dir" init -b main >/dev/null 2>&1 || {
    git -C "$project_dir" init >/dev/null
    git -C "$project_dir" checkout -b main >/dev/null
  }
  git -C "$project_dir" config user.email "boxhaven-smoke@example.invalid"
  git -C "$project_dir" config user.name "BoxHaven Smoke"
  printf 'boxhaven smoke project %s\n' "$prefix" > "${project_dir}/README.md"
  git -C "$project_dir" add README.md
  git -C "$project_dir" commit -m "Initial smoke project" >/dev/null
  if [ -n "$git_remote" ]; then
    git -C "$project_dir" remote add origin "$git_remote"
  fi
}

bh() {
  (cd "$project_dir" && BOXHAVEN_BACKEND_URL="$backend_url" "$bh_bin" "$@")
}

run_remote() {
  local name="$1"
  local script="$2"
  bh run "$name" run bash -lc "$script"
}

preview_url_for() {
  local name="$1"
  bh list | awk -v name="$name" '$1 == name { print $3; exit }'
}

create_boxes() {
  for name in "${boxes[@]}"; do
    log "creating ${name}"
    bh create "$name" --tier "$tier"
    created+=("$name")
  done
  for name in "${boxes[@]}"; do
    bh list | awk -v name="$name" '$1 == name { found=1 } END { exit(found ? 0 : 1) }'
  done
}

verify_runtime() {
  local name="$1"
  log "verifying runtime on ${name}"
  run_remote "$name" 'set -euo pipefail
test "$BOXHAVEN_REMOTE" = "1"
test "$BOXHAVEN_PROJECT_PATH" = "/opt/boxhaven/project"
test -d /opt/boxhaven/project/.git
command -v codex >/dev/null
command -v claude >/dev/null
command -v gh >/dev/null
command -v tmux >/dev/null
command -v docker >/dev/null
git -C /opt/boxhaven/project status --short >/dev/null
'
}

verify_github_auth() {
  local name="$1"
  if [ -z "$git_remote" ]; then
    log "skipping GitHub auth check for ${name}; BOXHAVEN_SMOKE_GIT_REMOTE is not set"
    return
  fi
  if [ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    log "skipping GitHub auth check for ${name}; GH_TOKEN/GITHUB_TOKEN is not set"
    return
  fi
  log "verifying GitHub credential forwarding on ${name}"
  run_remote "$name" 'set -euo pipefail
test -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}"
printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep -q "^password="
'
}

verify_git_push() {
  local name="$1"
  if [ -z "$git_remote" ]; then
    log "skipping GitHub push check for ${name}; BOXHAVEN_SMOKE_GIT_REMOTE is not set"
    return
  fi
  if [ -z "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    log "skipping GitHub push check for ${name}; GH_TOKEN/GITHUB_TOKEN is not set"
    return
  fi
  local branch="boxhaven-smoke/${prefix}-${name}"
  log "verifying GitHub push on ${name} using ${branch}"
  local script
  script="$(cat <<EOF
set -euo pipefail
git config user.email "boxhaven-smoke@example.invalid"
git config user.name "BoxHaven Smoke"
git checkout -B "${branch}"
printf 'boxhaven smoke %s %s\n' "${name}" "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" > ".boxhaven-smoke-${name}"
git add ".boxhaven-smoke-${name}"
git commit -m "BoxHaven smoke ${name}"
git push origin "HEAD:refs/heads/${branch}"
git ls-remote --exit-code origin "refs/heads/${branch}" >/dev/null
git push origin ":refs/heads/${branch}"
EOF
)"
  run_remote "$name" "$script"
}

verify_preview() {
  local name="$1"
  log "verifying preview on ${name}"
  run_remote "$name" 'set -euo pipefail
mkdir -p /tmp/boxhaven-preview
printf "boxhaven preview smoke\n" > /tmp/boxhaven-preview/index.html
pkill -f "python3 -m http.server 80" >/dev/null 2>&1 || true
cd /tmp/boxhaven-preview
nohup python3 -m http.server 80 --bind 0.0.0.0 >/tmp/boxhaven-preview.log 2>&1 &
'
  local url
  url="$(preview_url_for "$name")"
  if [ -z "$url" ] || [ "$url" = "-" ]; then
    if [ "$require_preview" = "1" ]; then
      printf 'missing preview URL for %s\n' "$name" >&2
      exit 1
    fi
    log "skipping preview fetch for ${name}; no preview URL"
    return
  fi
  curl -fsS --retry 12 --retry-all-errors --retry-delay 5 "$url" | grep -q "boxhaven preview smoke"
}

verify_after_restart() {
  if [ -z "$restart_backend_cmd" ]; then
    return
  fi
  log "running backend restart command"
  bash -lc "$restart_backend_cmd"
  log "waiting ${agent_reconnect_sleep}s for agent reconnect"
  sleep "$agent_reconnect_sleep"
  for name in "${boxes[@]}"; do
    run_remote "$name" 'set -euo pipefail
printf "agent reconnected on %s\n" "$BOXHAVEN_PROJECT_PATH"
'
  done
}

require_command git
require_command curl
require_command awk
preflight
ensure_bh
init_project

log "backend URL: ${backend_url}"
log "box names: ${boxes[*]}"
create_boxes
for name in "${boxes[@]}"; do
  verify_runtime "$name"
  verify_github_auth "$name"
  verify_git_push "$name"
  verify_preview "$name"
done
verify_after_restart

log "remote lifecycle smoke passed"
