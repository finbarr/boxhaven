#!/usr/bin/env bash
set -euo pipefail

api_url="${BOXHAVEN_DIGITALOCEAN_API_URL:-https://api.digitalocean.com}"
api_url="${api_url%/}"
token="${DIGITALOCEAN_ACCESS_TOKEN:-${DIGITALOCEAN_TOKEN:-${DO_API_TOKEN:-}}}"
tag="${BOXHAVEN_DO_ALERT_TAG:-boxhaven}"
emails="${BOXHAVEN_ALERT_EMAILS:-}"
window="${BOXHAVEN_DO_ALERT_WINDOW:-5m}"
dry_run="${BOXHAVEN_DO_ALERT_DRY_RUN:-0}"
fixture_path="${BOXHAVEN_DO_ALERT_FIXTURE:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/ensure-digitalocean-alerts.sh

Idempotently creates baseline DigitalOcean Monitoring alert policies for
BoxHaven-tagged Droplets. Requires DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_TOKEN,
or DO_API_TOKEN with monitoring read/create scopes.

Env:
  BOXHAVEN_ALERT_EMAILS=ops@example.com,dev@example.com  # required
  BOXHAVEN_DO_ALERT_TAG=boxhaven
  BOXHAVEN_DO_ALERT_WINDOW=5m
  BOXHAVEN_DO_ALERT_DRY_RUN=1
  BOXHAVEN_DO_ALERT_FIXTURE=/path/to/alert_policies.json
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
  jq -cn --arg value "$(cat)" '$value | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))'
}

require_command curl
require_command jq

[ -n "$emails" ] || {
  printf 'set BOXHAVEN_ALERT_EMAILS to one or more email recipients\n' >&2
  exit 2
}
if [ -z "$token" ] && [ -z "$fixture_path" ]; then
  printf 'set DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_TOKEN, DO_API_TOKEN, or BOXHAVEN_DO_ALERT_FIXTURE\n' >&2
  exit 2
fi
if [ -n "$fixture_path" ] && [ "$dry_run" != "1" ]; then
  printf 'BOXHAVEN_DO_ALERT_FIXTURE requires BOXHAVEN_DO_ALERT_DRY_RUN=1\n' >&2
  exit 2
fi

emails_json="$(printf '%s' "$emails" | csv_json_array)"
if [ -n "$fixture_path" ]; then
  alerts_json="$(cat "$fixture_path")"
else
  alerts_json="$(api GET "/v2/monitoring/alerts?per_page=200")"
fi

definitions_json="$(jq -cn --arg tag "$tag" --arg window "$window" '[
  {
    description: "BoxHaven CPU above 80%",
    type: "v1/insights/droplet/cpu",
    value: 80,
    compare: "GreaterThan",
    window: $window,
    tags: [$tag]
  },
  {
    description: "BoxHaven memory above 90%",
    type: "v1/insights/droplet/memory_utilization_percent",
    value: 90,
    compare: "GreaterThan",
    window: $window,
    tags: [$tag]
  },
  {
    description: "BoxHaven disk above 85%",
    type: "v1/insights/droplet/disk_utilization_percent",
    value: 85,
    compare: "GreaterThan",
    window: $window,
    tags: [$tag]
  }
]')"

created=0
printf '%s' "$definitions_json" | jq -c '.[]' | while IFS= read -r definition; do
  description="$(printf '%s' "$definition" | jq -r '.description')"
  if printf '%s' "$alerts_json" | jq -e --arg description "$description" '(.policies // .alert_policies // .alerts // [])[]? | select(.description == $description)' >/dev/null; then
    printf 'alert policy already exists: %s\n' "$description"
    continue
  fi
  body="$(printf '%s' "$definition" | jq -c --argjson emails "$emails_json" '. + {enabled: true, entities: [], alerts: {email: $emails}}')"
  if [ "$dry_run" = "1" ]; then
    printf 'would create alert policy: %s\n' "$body"
  else
    api POST "/v2/monitoring/alerts" "$body" >/dev/null
    printf 'created alert policy: %s\n' "$description"
  fi
  created=$((created + 1))
done
