#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  npm run deploy:runtime
  deploy/digitalocean/deploy-runtime-image.sh [options] [-- build-image-options...]

Build, activate, and verify the remote VM image. This is intentionally separate
from the normal app/API/docs deploy because it creates and snapshots a
temporary DigitalOcean builder Droplet.

Options:
  --local          Run in this checkout instead of SSHing to the production host.
  --target HOST    SSH target for remote deploys.
                   Default: BOXHAVEN_DEPLOY_TARGET or root@app.boxhaven.dev.
  --dir PATH       Remote checkout path.
                   Default: BOXHAVEN_DEPLOY_DIR or /opt/boxhaven/app.
  --branch NAME    Branch to fast-forward on the remote checkout.
                   Default: BOXHAVEN_DEPLOY_BRANCH or master.
  --env-file PATH  Production env file path on the machine doing the build.
                   Default: BOXHAVEN_PRODUCTION_ENV_FILE or deploy/digitalocean/.env.production.
  --compose-overlay FILE
                   Additional Docker Compose file used by the final app deploy.
  --compose-overlay-env-file FILE
                   Additional Compose env file used by the final app deploy.
  -h, --help       Show this help.

Arguments after -- are passed to build-remote-image.sh.
EOF
}

die() {
  echo "deploy-runtime-image: $*" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

local_mode=0
deploy_target="${BOXHAVEN_DEPLOY_TARGET:-root@app.boxhaven.dev}"
deploy_dir="${BOXHAVEN_DEPLOY_DIR:-/opt/boxhaven/app}"
deploy_branch="${BOXHAVEN_DEPLOY_BRANCH:-master}"
env_file="${BOXHAVEN_PRODUCTION_ENV_FILE:-deploy/digitalocean/.env.production}"
compose_overlay_file="${BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_FILE:-}"
compose_overlay_env_file="${BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_ENV_FILE:-}"
build_args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --local)
      local_mode=1
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
    --env-file)
      [ "$#" -ge 2 ] || die "--env-file requires a value"
      env_file="$2"
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
    --)
      shift
      build_args+=("$@")
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      build_args+=("$1")
      shift
      ;;
  esac
done

if [ "$local_mode" -ne 1 ]; then
  [ -n "$deploy_target" ] || die "set BOXHAVEN_DEPLOY_TARGET, pass --target, or use --local on the Droplet"

  echo "Building remote image from ${deploy_branch} on ${deploy_target}:${deploy_dir}"
  ssh -A "$deploy_target" "bash -s" -- \
    "$deploy_dir" \
    "$deploy_branch" \
    "$env_file" \
    "${compose_overlay_file:-__boxhaven_unset__}" \
    "${compose_overlay_env_file:-__boxhaven_unset__}" \
    "${build_args[@]}" <<'REMOTE'
set -euo pipefail

deploy_dir="$1"
deploy_branch="$2"
env_file="$3"
compose_overlay_file="$4"
compose_overlay_env_file="$5"
shift 5

[ "$compose_overlay_file" = "__boxhaven_unset__" ] || export BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_FILE="$compose_overlay_file"
[ "$compose_overlay_env_file" = "__boxhaven_unset__" ] || export BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_ENV_FILE="$compose_overlay_env_file"
export BOXHAVEN_PRODUCTION_ENV_FILE="$env_file"

cd "$deploy_dir"

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

./deploy/digitalocean/build-remote-image.sh --env-file "$env_file" --set-active "$@"
./deploy/digitalocean/deploy-production.sh --local
REMOTE
  exit 0
fi

cd "$repo_root"

[ -f "$env_file" ] || die "missing ${env_file}; copy deploy/digitalocean/env.production.example and fill in production secrets"
./deploy/digitalocean/build-remote-image.sh --env-file "$env_file" --set-active "${build_args[@]}"
BOXHAVEN_PRODUCTION_ENV_FILE="$env_file" \
BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_FILE="$compose_overlay_file" \
BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_ENV_FILE="$compose_overlay_env_file" \
./deploy/digitalocean/deploy-production.sh --local
