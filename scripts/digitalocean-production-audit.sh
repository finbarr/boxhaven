#!/usr/bin/env bash
set -euo pipefail

api_url="${BOXHAVEN_DIGITALOCEAN_API_URL:-https://api.digitalocean.com}"
api_url="${api_url%/}"
token="${DIGITALOCEAN_ACCESS_TOKEN:-${DIGITALOCEAN_TOKEN:-${DO_API_TOKEN:-}}}"
fixtures_dir="${BOXHAVEN_DO_AUDIT_FIXTURES:-}"
boxhaven_tag="${BOXHAVEN_DO_AUDIT_TAG:-boxhaven}"
required_uptime_targets="${BOXHAVEN_DO_AUDIT_UPTIME_TARGETS:-https://api.boxhaven.dev/healthz,https://app.boxhaven.dev/healthz}"
active_snapshot="${BOXHAVEN_REMOTE_IMAGE:-}"
snapshot_keep_days="${BOXHAVEN_DO_AUDIT_SNAPSHOT_KEEP_DAYS:-30}"
fail_on_broad_ssh="${BOXHAVEN_DO_AUDIT_FAIL_BROAD_SSH:-1}"

usage() {
  cat <<'EOF'
Usage:
  scripts/digitalocean-production-audit.sh

Runs read-only production readiness checks against DigitalOcean. Set
DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_TOKEN, or DO_API_TOKEN for live API
checks. For local tests, set BOXHAVEN_DO_AUDIT_FIXTURES to a directory
containing JSON files named after the API resource:

  droplets.json
  firewalls.json
  alert_policies.json
  uptime_checks.json
  snapshots.json

Useful env:
  BOXHAVEN_DO_AUDIT_TAG=boxhaven
  BOXHAVEN_DO_AUDIT_UPTIME_TARGETS=https://api.boxhaven.dev/healthz,https://app.boxhaven.dev/healthz
  BOXHAVEN_DO_AUDIT_SNAPSHOT_KEEP_DAYS=30
  BOXHAVEN_DO_AUDIT_FAIL_BROAD_SSH=1
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

log() {
  printf '==> %s\n' "$*" >&2
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
  warnings=$((warnings + 1))
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

api_get() {
  local key="$1"
  local path="$2"
  local fixture_path="${fixtures_dir}/${key}.json"
  if [ -n "$fixtures_dir" ]; then
    [ -f "$fixture_path" ] || {
      printf 'missing fixture: %s\n' "$fixture_path" >&2
      exit 2
    }
    cat "$fixture_path"
    return
  fi
  [ -n "$token" ] || {
    printf 'set DIGITALOCEAN_ACCESS_TOKEN or BOXHAVEN_DO_AUDIT_FIXTURES\n' >&2
    exit 2
  }
  curl -fsS -H "Authorization: Bearer ${token}" "${api_url}${path}"
}

json_array_len() {
  jq -r "$1 | length"
}

csv_to_json_array() {
  jq -Rc 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))'
}

warnings=0
failures=0
now_epoch="$(date -u +%s)"
snapshot_keep_seconds=$((snapshot_keep_days * 24 * 60 * 60))
required_targets_json="$(printf '%s' "$required_uptime_targets" | csv_to_json_array)"

require_command curl
require_command jq
require_command date

droplets_json="$(api_get droplets "/v2/droplets?tag_name=${boxhaven_tag}&per_page=200")"
firewalls_json="$(api_get firewalls "/v2/firewalls?per_page=200")"
alerts_json="$(api_get alert_policies "/v2/monitoring/alerts?per_page=200")"
uptime_json="$(api_get uptime_checks "/v2/uptime/checks?per_page=200")"
snapshots_json="$(api_get snapshots "/v2/snapshots?resource_type=droplet&per_page=200")"

log "checking droplets tagged ${boxhaven_tag}"
boxhaven_droplets="$(printf '%s' "$droplets_json" | json_array_len '.droplets // []')"
if [ "$boxhaven_droplets" -eq 0 ]; then
  fail "no droplets found with tag ${boxhaven_tag}"
else
  log "found ${boxhaven_droplets} tagged droplets"
fi

inactive_droplets="$(printf '%s' "$droplets_json" | jq -r '.droplets[]? | select(.status != "active") | .name')"
if [ -n "$inactive_droplets" ]; then
  warn "tagged droplets are not active: $(printf '%s' "$inactive_droplets" | paste -sd, -)"
fi

log "checking firewall SSH exposure"
broad_ssh_rules="$(printf '%s' "$firewalls_json" | jq -r '
  .firewalls[]? as $fw
  | ($fw.inbound_rules // [])[]
  | select((.protocol == "tcp" or .protocol == "all") and (.ports == "22" or .ports == "all"))
  | select(((.sources.addresses // []) | index("0.0.0.0/0")) or ((.sources.addresses // []) | index("::/0")))
  | $fw.name
' | sort -u)"
if [ -n "$broad_ssh_rules" ]; then
  if [ "$fail_on_broad_ssh" = "1" ]; then
    fail "firewalls expose SSH broadly: $(printf '%s' "$broad_ssh_rules" | paste -sd, -)"
  else
    warn "firewalls expose SSH broadly: $(printf '%s' "$broad_ssh_rules" | paste -sd, -)"
  fi
fi

boxhaven_firewalls="$(printf '%s' "$firewalls_json" | jq -r --arg tag "$boxhaven_tag" '
  .firewalls[]?
  | select(((.tags // []) | index($tag)) or ((.droplet_ids // []) | length > 0))
  | .name
' | sort -u)"
if [ -z "$boxhaven_firewalls" ]; then
  warn "no firewall references tag ${boxhaven_tag} or explicit droplets"
fi

log "checking monitoring alert policies"
alert_count="$(printf '%s' "$alerts_json" | json_array_len '.policies // .alert_policies // .alerts // []')"
if [ "$alert_count" -eq 0 ]; then
  fail "no DigitalOcean monitoring alert policies found"
else
  log "found ${alert_count} alert policies"
fi

log "checking uptime checks"
missing_targets="$(printf '%s' "$uptime_json" | jq -r --argjson required "$required_targets_json" '
  [(.checks // [])[]?.target] as $targets
  | $required[]
  | select(($targets | index(.)) | not)
')"
if [ -n "$missing_targets" ]; then
  fail "missing uptime checks for: $(printf '%s' "$missing_targets" | paste -sd, -)"
fi

log "checking snapshots"
boxhaven_snapshots="$(printf '%s' "$snapshots_json" | jq -r '.snapshots[]? | select((.name // "") | startswith("boxhaven-remote-")) | [.id, .name, .created_at] | @tsv')"
if [ -z "$boxhaven_snapshots" ]; then
  fail "no boxhaven-remote snapshots found"
else
  log "found $(printf '%s\n' "$boxhaven_snapshots" | sed '/^$/d' | wc -l | tr -d ' ') BoxHaven remote snapshots"
fi
if [ -n "$active_snapshot" ]; then
  if ! printf '%s' "$snapshots_json" | jq -e --arg id "$active_snapshot" '.snapshots[]? | select((.id | tostring) == $id)' >/dev/null; then
    fail "active BOXHAVEN_REMOTE_IMAGE snapshot ${active_snapshot} was not found"
  fi
fi

old_snapshots="$(printf '%s' "$snapshots_json" | jq -r --arg active "$active_snapshot" --argjson now "$now_epoch" --argjson keep "$snapshot_keep_seconds" '
  .snapshots[]?
  | select((.name // "") | startswith("boxhaven-remote-"))
  | select((.id | tostring) != $active)
  | select(.created_at)
  | select(($now - ((.created_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601))) > $keep)
  | [.id, .name] | @tsv
')"
if [ -n "$old_snapshots" ]; then
  warn "old non-active BoxHaven snapshots should be reviewed: $(printf '%s' "$old_snapshots" | cut -f1 | paste -sd, -)"
fi

if [ "$failures" -gt 0 ]; then
  printf 'DigitalOcean production audit failed: %d failure(s), %d warning(s)\n' "$failures" "$warnings" >&2
  exit 1
fi

printf 'DigitalOcean production audit passed: %d warning(s)\n' "$warnings"
