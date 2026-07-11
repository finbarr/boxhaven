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
  --compose-overlay FILE
                   Additional Docker Compose file for externally managed services.
  --compose-overlay-env-file FILE
                   Additional Compose env file used with the overlay.
  -h, --help       Show this help.

Environment:
  BOXHAVEN_PRODUCTION_ENV_FILE         Compose env file for --local mode.
                                       Default: deploy/digitalocean/.env.production.
  BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_FILE
                                       Additional Docker Compose file.
  BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_ENV_FILE
                                       Additional env file used with the overlay.
  BOXHAVEN_PRODUCTION_API_HEALTH_URL   Default: https://api.boxhaven.dev/healthz.
  BOXHAVEN_PRODUCTION_APP_HEALTH_URL   Default: https://app.boxhaven.dev/healthz.
  BOXHAVEN_PRODUCTION_DOCS_HEALTH_URL  Default: https://docs.boxhaven.dev/.

Remote deploys use SSH agent forwarding so the Droplet can fetch private GitHub
repositories without storing a long-lived GitHub token on the host.
EOF
}

die() {
  echo "deploy-production: $*" >&2
  exit 1
}

env_file_value() {
  local key="$1"
  local file="$2"
  awk -v key="$key" '
    {
      line = $0
      sub(/\r$/, "", line)
    }
    line ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {
      sub("^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=[[:space:]]*", "", line)
      sub(/[[:space:]]+$/, "", line)
      if ((substr(line, 1, 1) == "\"" && substr(line, length(line), 1) == "\"") ||
          (substr(line, 1, 1) == "\047" && substr(line, length(line), 1) == "\047")) {
        line = substr(line, 2, length(line) - 2)
      }
      value = line
    }
    END { print value }
  ' "$file"
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

local_mode=0
verify_only=0
deploy_target="${BOXHAVEN_DEPLOY_TARGET:-root@app.boxhaven.dev}"
deploy_dir="${BOXHAVEN_DEPLOY_DIR:-/opt/boxhaven/app}"
deploy_branch="${BOXHAVEN_DEPLOY_BRANCH:-master}"
compose_overlay_file="${BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_FILE:-}"
compose_overlay_env_file="${BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_ENV_FILE:-}"

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
    --compose-overlay)
      [ "$#" -ge 2 ] || die "--compose-overlay requires a value"
      compose_overlay_file="$2"
      shift 2
      ;;
    --compose-overlay-env-file)
      [ "$#" -ge 2 ] || die "--compose-overlay-env-file requires a value"
      compose_overlay_env_file="$2"
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

  remote_mode_arg="--deploy"
  if [ "$verify_only" -eq 1 ]; then
    remote_mode_arg="--verify-only"
  fi
  unset_arg="__boxhaven_unset__"
  printf -v remote_command '%q ' bash -s -- \
    "$deploy_dir" \
    "$deploy_branch" \
    "$remote_mode_arg" \
    "${BOXHAVEN_PRODUCTION_ENV_FILE:-$unset_arg}" \
    "${BOXHAVEN_PRODUCTION_API_HEALTH_URL:-$unset_arg}" \
    "${BOXHAVEN_PRODUCTION_APP_HEALTH_URL:-$unset_arg}" \
    "${BOXHAVEN_PRODUCTION_DOCS_HEALTH_URL:-$unset_arg}" \
    "${compose_overlay_file:-$unset_arg}" \
    "${compose_overlay_env_file:-$unset_arg}"

  echo "Deploying ${deploy_branch} to ${deploy_target}:${deploy_dir}"
  ssh -A "$deploy_target" "$remote_command" <<'REMOTE'
set -euo pipefail

deploy_dir="$1"
deploy_branch="$2"
mode_arg="${3:-}"
env_file="${4:-}"
api_health_url="${5:-}"
app_health_url="${6:-}"
docs_health_url="${7:-}"
compose_overlay_file="${8:-}"
compose_overlay_env_file="${9:-}"
unset_arg="__boxhaven_unset__"

case "$mode_arg" in
  --deploy|--verify-only)
    ;;
  *)
    echo "deploy-production: unexpected remote mode: ${mode_arg:-<empty>}" >&2
    exit 1
    ;;
esac

[ "$env_file" = "$unset_arg" ] || export BOXHAVEN_PRODUCTION_ENV_FILE="$env_file"
[ "$api_health_url" = "$unset_arg" ] || export BOXHAVEN_PRODUCTION_API_HEALTH_URL="$api_health_url"
[ "$app_health_url" = "$unset_arg" ] || export BOXHAVEN_PRODUCTION_APP_HEALTH_URL="$app_health_url"
[ "$docs_health_url" = "$unset_arg" ] || export BOXHAVEN_PRODUCTION_DOCS_HEALTH_URL="$docs_health_url"
[ "$compose_overlay_file" = "$unset_arg" ] || export BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_FILE="$compose_overlay_file"
[ "$compose_overlay_env_file" = "$unset_arg" ] || export BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_ENV_FILE="$compose_overlay_env_file"

cd "$deploy_dir"

if [ "$mode_arg" = "--deploy" ]; then
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

if [ "$mode_arg" = "--verify-only" ]; then
  exec ./deploy/digitalocean/deploy-production.sh --local --verify-only
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
docs_health_url="${BOXHAVEN_PRODUCTION_DOCS_HEALTH_URL:-https://docs.boxhaven.dev/}"

if [ -n "$compose_overlay_env_file" ] && [ -z "$compose_overlay_file" ]; then
  die "an overlay env file requires --compose-overlay or BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_FILE"
fi

[ -f "$compose_file" ] || die "missing ${compose_file}"
[ -f "$env_file" ] || die "missing ${env_file}; copy deploy/digitalocean/env.production.example and fill in production secrets"
[ -z "$compose_overlay_file" ] || [ -f "$compose_overlay_file" ] || die "missing overlay Compose file ${compose_overlay_file}"
[ -z "$compose_overlay_env_file" ] || [ -f "$compose_overlay_env_file" ] || die "missing overlay env file ${compose_overlay_env_file}"

configured_policy_url="${BOXHAVEN_COMMERCIAL_POLICY_URL:-}"
if [ -z "$configured_policy_url" ]; then
  configured_policy_url="$(env_file_value BOXHAVEN_COMMERCIAL_POLICY_URL "$env_file")"
fi
if [ -n "$configured_policy_url" ] && [ -z "$compose_overlay_file" ]; then
  die "BOXHAVEN_COMMERCIAL_POLICY_URL is configured but no Compose overlay was supplied; refusing to remove the external policy service"
fi

command -v docker >/dev/null 2>&1 || die "docker is required"
command -v curl >/dev/null 2>&1 || die "curl is required"

compose_args=(--env-file "$env_file" -f "$compose_file")
if [ -n "$compose_overlay_env_file" ]; then
  compose_args+=(--env-file "$compose_overlay_env_file")
fi
if [ -n "$compose_overlay_file" ]; then
  compose_args+=(-f "$compose_overlay_file")
fi

if [ "$verify_only" -ne 1 ]; then
  echo "Building docs site"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e npm_config_cache=/tmp/npm-cache \
    -v "${repo_root}:/work" \
    -w /tmp \
    node:22-alpine \
    sh -c '
      set -eu
      mkdir -p /tmp/docs
      tar -C /work/docs \
        --exclude ./node_modules \
        --exclude ./.vitepress/dist \
        --exclude ./.vitepress/cache \
        -cf - . | tar -C /tmp/docs -xf -
      cd /tmp/docs
      npm ci
      npm run docs:build
      rm -rf /work/docs/.vitepress/dist
      mkdir -p /work/docs/.vitepress
      cp -R /tmp/docs/.vitepress/dist /work/docs/.vitepress/dist
    '

  echo "Building and starting production containers"
  docker compose "${compose_args[@]}" up -d --build --remove-orphans
  echo "Recreating Caddy to apply mounted configuration"
  docker compose "${compose_args[@]}" up -d --force-recreate --no-deps caddy
fi

echo "Checking production containers"
docker compose "${compose_args[@]}" ps

echo "Checking ${api_health_url}"
curl -fsS "$api_health_url" >/dev/null

echo "Checking ${app_health_url}"
curl -fsS "$app_health_url" >/dev/null

echo "Checking ${docs_health_url}"
curl -fsS "$docs_health_url" >/dev/null

echo "Production deploy verified"
