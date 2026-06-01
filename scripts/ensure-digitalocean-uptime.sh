#!/usr/bin/env bash
set -euo pipefail

api_url="${BOXHAVEN_DIGITALOCEAN_API_URL:-https://api.digitalocean.com}"
api_url="${api_url%/}"
token="${DIGITALOCEAN_ACCESS_TOKEN:-${DIGITALOCEAN_TOKEN:-${DO_API_TOKEN:-}}}"
targets="${BOXHAVEN_DO_UPTIME_TARGETS:-https://api.boxhaven.dev/healthz,https://app.boxhaven.dev/healthz}"
regions="${BOXHAVEN_DO_UPTIME_REGIONS:-us_east,us_west,eu_west}"
name_prefix="${BOXHAVEN_DO_UPTIME_NAME_PREFIX:-boxhaven}"
dry_run="${BOXHAVEN_DO_UPTIME_DRY_RUN:-0}"
fixture_path="${BOXHAVEN_DO_UPTIME_FIXTURE:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/ensure-digitalocean-uptime.sh

Idempotently creates DigitalOcean Uptime HTTP checks for BoxHaven production
health endpoints. Requires DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_TOKEN, or
DO_API_TOKEN with uptime read/create scopes.

Env:
  BOXHAVEN_DO_UPTIME_TARGETS=https://api.boxhaven.dev/healthz,https://app.boxhaven.dev/healthz
  BOXHAVEN_DO_UPTIME_REGIONS=us_east,us_west,eu_west
  BOXHAVEN_DO_UPTIME_NAME_PREFIX=boxhaven
  BOXHAVEN_DO_UPTIME_DRY_RUN=1
  BOXHAVEN_DO_UPTIME_FIXTURE=/path/to/uptime_checks.json
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

api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      -d "$body" \
      "${api_url}${path}"
  else
    curl -fsS -X "$method" \
      -H "Authorization: Bearer ${token}" \
      "${api_url}${path}"
  fi
}

csv_json_array() {
  jq -Rc 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))'
}

require_command curl
require_command jq

[ -n "$token" ] || {
  if [ -z "$fixture_path" ]; then
    printf 'set DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_TOKEN, DO_API_TOKEN, or BOXHAVEN_DO_UPTIME_FIXTURE\n' >&2
    exit 2
  fi
}
if [ -n "$fixture_path" ] && [ "$dry_run" != "1" ]; then
  printf 'BOXHAVEN_DO_UPTIME_FIXTURE requires BOXHAVEN_DO_UPTIME_DRY_RUN=1\n' >&2
  exit 2
fi

if [ -n "$fixture_path" ]; then
  checks_json="$(cat "$fixture_path")"
else
  checks_json="$(api GET "/v2/uptime/checks?per_page=200")"
fi
regions_json="$(printf '%s' "$regions" | csv_json_array)"

printf '%s\n' "$targets" | tr ',' '\n' | while IFS= read -r raw_target; do
  target="$(printf '%s' "$raw_target" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"
  [ -n "$target" ] || continue
  if printf '%s' "$checks_json" | jq -e --arg target "$target" '(.checks // [])[]? | select(.target == $target)' >/dev/null; then
    printf 'uptime check already exists: %s\n' "$target"
    continue
  fi
  host="$(printf '%s' "$target" | sed -E 's#^https?://##; s#/.*$##; s#:#-#g')"
  body="$(jq -cn --arg name "${name_prefix}-${host}" --arg target "$target" --argjson regions "$regions_json" '{
    name: $name,
    type: "https",
    target: $target,
    regions: $regions,
    enabled: true
  }')"
  if [ "$dry_run" = "1" ]; then
    printf 'would create uptime check: %s\n' "$body"
    continue
  fi
  api POST "/v2/uptime/checks" "$body" >/dev/null
  printf 'created uptime check: %s\n' "$target"
done
