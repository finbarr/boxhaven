#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${script_dir}/lib/digitalocean-pagination.sh"

api_url="${BOXHAVEN_DIGITALOCEAN_API_URL:-https://api.digitalocean.com}"
api_url="${api_url%/}"
token="${DIGITALOCEAN_ACCESS_TOKEN:-${DIGITALOCEAN_TOKEN:-${DO_API_TOKEN:-}}}"
fixtures_dir="${BOXHAVEN_DO_ACCOUNT_AUDIT_FIXTURES:-}"
expected_droplets="${BOXHAVEN_DO_ACCOUNT_EXPECTED_DROPLETS:-}"
cleanup_droplets="${BOXHAVEN_DO_ACCOUNT_CLEANUP_DROPLETS:-}"
cleanup_snapshot_ids="${BOXHAVEN_DO_ACCOUNT_CLEANUP_SNAPSHOT_IDS:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/digitalocean-account-cleanup-audit.sh

Runs read-only DigitalOcean account cleanup checks for known legacy resources
that should be inspected, migrated, or deleted outside the BoxHaven deployment
audit.

Env:
  DIGITALOCEAN_ACCESS_TOKEN=...                 # or DIGITALOCEAN_TOKEN / DO_API_TOKEN
  BOXHAVEN_DO_ACCOUNT_EXPECTED_DROPLETS=name1,name2
  BOXHAVEN_DO_ACCOUNT_CLEANUP_DROPLETS=web
  BOXHAVEN_DO_ACCOUNT_CLEANUP_SNAPSHOT_IDS=160948396,160956820
  BOXHAVEN_DO_ACCOUNT_AUDIT_FIXTURES=dir        # local tests; expects droplets.json and snapshots.json
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

api_get() {
  local fixture_key="$1"
  local response_key="$2"
  local path="$3"
  local fixture_path="${fixtures_dir}/${fixture_key}.json"
  if [ -n "$fixtures_dir" ]; then
    [ -f "$fixture_path" ] || {
      printf 'missing fixture: %s\n' "$fixture_path" >&2
      exit 2
    }
    cat "$fixture_path"
    return
  fi
  [ -n "$token" ] || {
    printf 'set DIGITALOCEAN_ACCESS_TOKEN or BOXHAVEN_DO_ACCOUNT_AUDIT_FIXTURES\n' >&2
    exit 2
  }
  digitalocean_api_get_all "$response_key" "$path"
}

csv_to_json_array() {
  jq -Rc 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))'
}

log() {
  printf '==> %s\n' "$*" >&2
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

require_command curl
require_command jq

failures=0
expected_droplets_json="$(printf '%s' "$expected_droplets" | csv_to_json_array)"
cleanup_droplets_json="$(printf '%s' "$cleanup_droplets" | csv_to_json_array)"
cleanup_snapshot_ids_json="$(printf '%s' "$cleanup_snapshot_ids" | csv_to_json_array)"

droplets_json="$(api_get droplets droplets "/v2/droplets?per_page=200")"
snapshots_json="$(api_get snapshots snapshots "/v2/snapshots?resource_type=droplet&per_page=200")"

log "checking DigitalOcean droplets"
missing_droplets="$(printf '%s' "$droplets_json" | jq -r --argjson expected "$expected_droplets_json" '
  [(.droplets // [])[]?.name] as $names
  | $expected[]
  | select(($names | index(.)) | not)
')"
if [ -n "$missing_droplets" ]; then
  fail "expected droplets are missing: $(printf '%s' "$missing_droplets" | paste -sd, -)"
fi

unexpected_droplets="$(printf '%s' "$droplets_json" | jq -r --argjson expected "$expected_droplets_json" '
  select(($expected | length) > 0)
  | (.droplets // [])[]?
  | select((.status // "") != "archive")
  | .name as $name
  | select(($expected | index($name)) | not)
  | .name
')"
if [ -n "$unexpected_droplets" ]; then
  fail "unexpected active droplets found: $(printf '%s' "$unexpected_droplets" | paste -sd, -)"
fi

cleanup_droplets_found="$(printf '%s' "$droplets_json" | jq -r --argjson cleanup "$cleanup_droplets_json" '
  (.droplets // [])[]?
  | .name as $name
  | select($cleanup | index($name))
  | "\(.name)\t\(.id // "")\t\(.status // "")\t\(.created_at // "")"
')"
if [ -n "$cleanup_droplets_found" ]; then
  fail "cleanup droplets still exist: $(printf '%s' "$cleanup_droplets_found" | cut -f1 | paste -sd, -)"
fi

log "checking DigitalOcean snapshots"
cleanup_snapshots_found="$(printf '%s' "$snapshots_json" | jq -r --argjson cleanup "$cleanup_snapshot_ids_json" '
  (.snapshots // [])[]?
  | (.id | tostring) as $id
  | select($cleanup | index($id))
  | "\($id)\t\(.name // "")\t\(.created_at // "")"
')"
if [ -n "$cleanup_snapshots_found" ]; then
  fail "cleanup snapshots still exist: $(printf '%s' "$cleanup_snapshots_found" | cut -f1 | paste -sd, -)"
fi

if [ "$failures" -gt 0 ]; then
  printf 'DigitalOcean account cleanup audit failed: %d failure(s)\n' "$failures" >&2
  exit 1
fi

printf 'DigitalOcean account cleanup audit passed\n'
