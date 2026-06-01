#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  npm run deploy:production
  deploy/digitalocean/deploy-production.sh [options]

Options:
  --local          Run the Docker Compose deploy in this checkout instead of
                   SSHing to the production host.
  --verify-only    Skip container updates and run production health checks.
  --target HOST    SSH target for remote deploys.
                   Default: BOXHAVEN_DEPLOY_TARGET or root@app.boxhaven.dev.
  --dir PATH       Remote checkout path.
                   Default: BOXHAVEN_DEPLOY_DIR or /opt/boxhaven/app.
  --branch NAME    Branch to fast-forward on the remote checkout.
                   Default: BOXHAVEN_DEPLOY_BRANCH or master.
  -h, --help       Show this help.

Environment:
  BOXHAVEN_PRODUCTION_ENV_FILE         Compose env file for --local mode.
                                       Default: deploy/digitalocean/.env.production.
  BOXHAVEN_PRODUCTION_API_HEALTH_URL   Default: https://api.boxhaven.dev/healthz.
  BOXHAVEN_PRODUCTION_APP_HEALTH_URL   Default: https://app.boxhaven.dev/healthz.
EOF
}

die() {
  echo "deploy-production: $*" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

local_mode=0
verify_only=0
deploy_target="${BOXHAVEN_DEPLOY_TARGET:-root@app.boxhaven.dev}"
deploy_dir="${BOXHAVEN_DEPLOY_DIR:-/opt/boxhaven/app}"
deploy_branch="${BOXHAVEN_DEPLOY_BRANCH:-master}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --local)
      local_mode=1
      shift
      ;;
    --verify-only)
      verify_only=1
      shift
      ;;
    --target)
      [ "$#" -ge 2 ] || die "--target requires a value"
      deploy_target="$2"
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || die "--dir requires a value"
      deploy_dir="$2"
      shift 2
      ;;
    --branch|--ref)
      [ "$#" -ge 2 ] || die "$1 requires a value"
      deploy_branch="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

if [ "$local_mode" -ne 1 ]; then
  [ -n "$deploy_target" ] || die "set BOXHAVEN_DEPLOY_TARGET, pass --target, or use --local on the Droplet"

  remote_verify_arg=""
  if [ "$verify_only" -eq 1 ]; then
    remote_verify_arg="--verify-only"
  fi

  echo "Deploying ${deploy_branch} to ${deploy_target}:${deploy_dir}"
  ssh "$deploy_target" "bash -s" -- \
    "$deploy_dir" \
    "$deploy_branch" \
    "$remote_verify_arg" \
    "${BOXHAVEN_PRODUCTION_ENV_FILE:-}" \
    "${BOXHAVEN_PRODUCTION_API_HEALTH_URL:-}" \
    "${BOXHAVEN_PRODUCTION_APP_HEALTH_URL:-}" <<'REMOTE'
set -euo pipefail

deploy_dir="$1"
deploy_branch="$2"
verify_arg="${3:-}"
env_file="${4:-}"
api_health_url="${5:-}"
app_health_url="${6:-}"

[ -z "$env_file" ] || export BOXHAVEN_PRODUCTION_ENV_FILE="$env_file"
[ -z "$api_health_url" ] || export BOXHAVEN_PRODUCTION_API_HEALTH_URL="$api_health_url"
[ -z "$app_health_url" ] || export BOXHAVEN_PRODUCTION_APP_HEALTH_URL="$app_health_url"

cd "$deploy_dir"

if [ -z "$verify_arg" ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "remote checkout has uncommitted changes:" >&2
    git status --short >&2
    exit 1
  fi

  current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ "$current_branch" != "$deploy_branch" ]; then
    echo "remote checkout is on '${current_branch:-detached HEAD}', expected '${deploy_branch}'" >&2
    exit 1
  fi

  git fetch --prune origin
  git merge --ff-only "origin/${deploy_branch}"
fi

if [ -n "$verify_arg" ]; then
  exec ./deploy/digitalocean/deploy-production.sh --local "$verify_arg"
fi

exec ./deploy/digitalocean/deploy-production.sh --local
REMOTE
  exit 0
fi

cd "$repo_root"

compose_file="deploy/digitalocean/docker-compose.yml"
env_file="${BOXHAVEN_PRODUCTION_ENV_FILE:-deploy/digitalocean/.env.production}"
api_health_url="${BOXHAVEN_PRODUCTION_API_HEALTH_URL:-https://api.boxhaven.dev/healthz}"
app_health_url="${BOXHAVEN_PRODUCTION_APP_HEALTH_URL:-https://app.boxhaven.dev/healthz}"

[ -f "$compose_file" ] || die "missing ${compose_file}"
[ -f "$env_file" ] || die "missing ${env_file}; copy deploy/digitalocean/env.production.example and fill in production secrets"
command -v docker >/dev/null 2>&1 || die "docker is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

if [ "$verify_only" -ne 1 ]; then
  echo "Building and starting production containers"
  docker compose --env-file "$env_file" -f "$compose_file" up -d --build --remove-orphans
fi

echo "Checking production containers"
docker compose --env-file "$env_file" -f "$compose_file" ps

echo "Checking ${api_health_url}"
curl -fsS "$api_health_url" >/dev/null

echo "Checking ${app_health_url}"
curl -fsS "$app_health_url" >/dev/null

echo "Production deploy verified"
