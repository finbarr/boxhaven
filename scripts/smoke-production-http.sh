#!/usr/bin/env bash
set -euo pipefail

api_url="${BOXHAVEN_PRODUCTION_API_URL:-${BOXHAVEN_API_URL:-https://api.boxhaven.dev}}"
app_url="${BOXHAVEN_PRODUCTION_APP_URL:-${BOXHAVEN_APP_URL:-https://app.boxhaven.dev}}"
metrics_token="${BOXHAVEN_METRICS_BEARER_TOKEN:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/smoke-production-http.sh

Runs production HTTP health and metrics checks against the hosted app/API. This
is intended for deployed production or production-equivalent environments, not
local unit testing.

Env:
  BOXHAVEN_PRODUCTION_API_URL=https://api.boxhaven.dev
  BOXHAVEN_PRODUCTION_APP_URL=https://app.boxhaven.dev
  BOXHAVEN_METRICS_BEARER_TOKEN=...
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  }
}

trim_url() {
  local value="$1"
  printf '%s' "${value%/}"
}

log() {
  printf '==> %s\n' "$*" >&2
}

require_command curl
require_command grep

[ -n "$metrics_token" ] || {
  printf 'set BOXHAVEN_METRICS_BEARER_TOKEN before smoking production metrics\n' >&2
  exit 2
}

api_url="$(trim_url "$api_url")"
app_url="$(trim_url "$app_url")"

log "checking API health at ${api_url}"
curl -fsS "${api_url}/healthz" | grep -q '^ok'

log "checking app health at ${app_url}"
curl -fsS "${app_url}/healthz" | grep -q '^ok'

log "checking metrics rejects unauthenticated requests"
metrics_status="$(curl -sS -o /dev/null -w '%{http_code}' "${api_url}/metrics")"
if [ "$metrics_status" != "401" ]; then
  printf 'expected unauthenticated metrics status 401, got %s\n' "$metrics_status" >&2
  exit 1
fi

log "checking authenticated metrics"
curl -fsS -H "Authorization: Bearer ${metrics_token}" "${api_url}/metrics" | grep -q '^boxhaven_machines '

printf 'production HTTP smoke passed\n'
