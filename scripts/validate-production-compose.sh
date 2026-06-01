#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="${BOXHAVEN_PRODUCTION_COMPOSE_FILE:-${repo_root}/deploy/digitalocean/docker-compose.yml}"
env_file="${BOXHAVEN_PRODUCTION_ENV_FILE:-${repo_root}/deploy/digitalocean/.env.production}"

usage() {
  cat <<'EOF'
Usage:
  scripts/validate-production-compose.sh [--env-file deploy/digitalocean/.env.production]

Validates the production env file and renders the DigitalOcean Docker Compose
configuration. This catches missing variables and invalid Compose structure
before a production restart.

Env:
  BOXHAVEN_PRODUCTION_COMPOSE_FILE=deploy/digitalocean/docker-compose.yml
  BOXHAVEN_PRODUCTION_ENV_FILE=deploy/digitalocean/.env.production
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      [ "$#" -ge 2 ] || {
        printf '%s\n' '--env-file requires a path' >&2
        exit 2
      }
      env_file="$2"
      shift 2
      ;;
    --env-file=*)
      env_file="${1#--env-file=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

[ -f "$compose_file" ] || {
  printf 'production compose file does not exist: %s\n' "$compose_file" >&2
  exit 2
}

scripts/validate-production-env.sh --env-file "$env_file" >/dev/null

if docker compose version >/dev/null 2>&1; then
  docker compose --env-file "$env_file" -f "$compose_file" config --quiet
elif command -v docker-compose >/dev/null 2>&1; then
  docker-compose --env-file "$env_file" -f "$compose_file" config --quiet
else
  printf 'missing Docker Compose for production compose validation\n' >&2
  exit 2
fi

printf 'production compose validation passed: %s\n' "$compose_file"
