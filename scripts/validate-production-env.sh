#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${BOXHAVEN_PRODUCTION_ENV_FILE:-${repo_root}/deploy/digitalocean/.env.production}"

usage() {
  cat <<'EOF'
Usage:
  scripts/validate-production-env.sh [--env-file deploy/digitalocean/.env.production]

Validates that a production env file has required values and is not still using
the checked-in example placeholders.

Env:
  BOXHAVEN_PRODUCTION_ENV_FILE=deploy/digitalocean/.env.production
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --env-file)
      [ "$#" -ge 2 ] || {
        printf '--env-file requires a path\n' >&2
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

[ -f "$env_file" ] || {
  printf 'production env file does not exist: %s\n' "$env_file" >&2
  exit 2
}

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

require_value() {
  local key="$1"
  local value="${!key:-}"
  [ -n "$value" ] || fail "${key} is required"
}

reject_placeholder() {
  local key="$1"
  local value="${!key:-}"
  case "$value" in
    ""|replace-*|*replace-with*|*example*|dop_v1_example)
      fail "${key} still looks like a placeholder"
      ;;
  esac
}

require_url() {
  local key="$1"
  local value="${!key:-}"
  case "$value" in
    https://*) ;;
    *) fail "${key} must be an https URL" ;;
  esac
}

required_vars=(
  ACME_EMAIL
  BOXHAVEN_APP_HOST
  BOXHAVEN_API_HOST
  BOXHAVEN_PREVIEW_BASE_DOMAIN
  BOXHAVEN_APP_URL
  BOXHAVEN_API_URL
  BETTER_AUTH_URL
  BETTER_AUTH_TRUSTED_ORIGINS
  BOXHAVEN_BACKEND_CORS_ORIGINS
  BETTER_AUTH_SECRET
  BOXHAVEN_SIGNUP_MODE
  DIGITALOCEAN_ACCESS_TOKEN
)

for key in "${required_vars[@]}"; do
  require_value "$key"
done

placeholder_vars=(
  ACME_EMAIL
  BETTER_AUTH_SECRET
  BOXHAVEN_SIGNUP_INVITE_CODES
  DIGITALOCEAN_ACCESS_TOKEN
)

for key in "${placeholder_vars[@]}"; do
  reject_placeholder "$key"
done

require_url BOXHAVEN_APP_URL
require_url BOXHAVEN_API_URL
require_url BETTER_AUTH_URL

case "${BETTER_AUTH_URL:-}" in
  */v1/auth) ;;
  *) fail "BETTER_AUTH_URL must end with /v1/auth" ;;
esac

case "${BOXHAVEN_SIGNUP_MODE:-}" in
  invite)
    require_value BOXHAVEN_SIGNUP_INVITE_CODES
    reject_placeholder BOXHAVEN_SIGNUP_INVITE_CODES
    ;;
  disabled)
    ;;
  *)
    fail "BOXHAVEN_SIGNUP_MODE must be invite or disabled in production"
    ;;
esac

auth_secret="${BETTER_AUTH_SECRET:-}"
if [ "${#auth_secret}" -lt 32 ]; then
  fail "BETTER_AUTH_SECRET must be at least 32 characters"
fi

if [ "${BOXHAVEN_APP_URL:-}" = "${BOXHAVEN_API_URL:-}" ]; then
  fail "BOXHAVEN_APP_URL and BOXHAVEN_API_URL should be distinct origins"
fi

if [ "$failures" -gt 0 ]; then
  printf 'production env validation failed: %d failure(s)\n' "$failures" >&2
  exit 1
fi

printf 'production env validation passed: %s\n' "$env_file"
