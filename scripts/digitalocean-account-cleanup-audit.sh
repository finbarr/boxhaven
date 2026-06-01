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
expected_projects="${BOXHAVEN_DO_ACCOUNT_EXPECTED_PROJECTS:-}"
droplet_projects="${BOXHAVEN_DO_ACCOUNT_DROPLET_PROJECTS:-}"
require_default_project_empty="${BOXHAVEN_DO_ACCOUNT_REQUIRE_DEFAULT_PROJECT_EMPTY:-0}"
require_firewall_coverage="${BOXHAVEN_DO_ACCOUNT_REQUIRE_FIREWALL_COVERAGE:-0}"
max_month_to_date_usage="${BOXHAVEN_DO_ACCOUNT_MAX_MONTH_TO_DATE_USAGE:-}"

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
  BOXHAVEN_DO_ACCOUNT_EXPECTED_PROJECTS=boxhaven,fundy,legacy
  BOXHAVEN_DO_ACCOUNT_DROPLET_PROJECTS=boxhaven-control-prod-nyc3-01=boxhaven,web=legacy
  BOXHAVEN_DO_ACCOUNT_REQUIRE_DEFAULT_PROJECT_EMPTY=1
  BOXHAVEN_DO_ACCOUNT_REQUIRE_FIREWALL_COVERAGE=1
  BOXHAVEN_DO_ACCOUNT_MAX_MONTH_TO_DATE_USAGE=250
  BOXHAVEN_DO_ACCOUNT_AUDIT_FIXTURES=dir        # local tests; expects droplets.json, snapshots.json, and optional project fixtures
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

api_get_project_resources() {
  local project_id="$1"
  local project_name="$2"
  local safe_name fixture_path
  safe_name="$(printf '%s' "$project_name" | tr -c 'A-Za-z0-9_-' '_')"
  fixture_path="${fixtures_dir}/project_resources_${safe_name}.json"
  if [ -n "$fixtures_dir" ]; then
    [ -f "$fixture_path" ] || {
      printf 'missing fixture: %s\n' "$fixture_path" >&2
      exit 2
    }
    cat "$fixture_path"
    return
  fi
  digitalocean_api_get_all resources "/v2/projects/${project_id}/resources?per_page=200"
}

api_get_raw() {
  local fixture_key="$1"
  local path="$2"
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
  digitalocean_api_get_url "$path"
}

csv_to_json_array() {
  jq -Rc 'split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))'
}

csv_assignments_to_json_array() {
  jq -Rc 'split(",")
    | map(gsub("^\\s+|\\s+$"; ""))
    | map(select(length > 0))
    | map(split("=") | select(length == 2) | {name: .[0], project: .[1]})'
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
require_command awk

failures=0
if [ -n "$max_month_to_date_usage" ] && ! [[ "$max_month_to_date_usage" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  printf 'BOXHAVEN_DO_ACCOUNT_MAX_MONTH_TO_DATE_USAGE must be a non-negative number\n' >&2
  exit 2
fi
expected_droplets_json="$(printf '%s' "$expected_droplets" | csv_to_json_array)"
cleanup_droplets_json="$(printf '%s' "$cleanup_droplets" | csv_to_json_array)"
cleanup_snapshot_ids_json="$(printf '%s' "$cleanup_snapshot_ids" | csv_to_json_array)"
expected_projects_json="$(printf '%s' "$expected_projects" | csv_to_json_array)"
droplet_projects_json="$(printf '%s' "$droplet_projects" | csv_assignments_to_json_array)"

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

if [ "$expected_projects" != "" ] || [ "$droplet_projects" != "" ] || [ "$require_default_project_empty" = "1" ]; then
  projects_json="$(api_get projects projects "/v2/projects?per_page=200")"
  log "checking DigitalOcean projects"
  missing_projects="$(printf '%s' "$projects_json" | jq -r --argjson expected "$expected_projects_json" '
    [(.projects // [])[]?.name] as $names
    | $expected[]
    | select(($names | index(.)) | not)
  ')"
  if [ -n "$missing_projects" ]; then
    fail "expected projects are missing: $(printf '%s' "$missing_projects" | paste -sd, -)"
  fi

  project_resources_json="[]"
  while IFS="$(printf '\t')" read -r project_id project_name is_default; do
    [ -n "$project_id" ] || continue
    resources_json="$(api_get_project_resources "$project_id" "$project_name")"
    project_rows="$(printf '%s' "$resources_json" | jq -c --arg project "$project_name" --arg is_default "$is_default" '
      [(.resources // [])[]?
       | select((.urn // "") | startswith("do:droplet:"))
       | {project: $project, is_default: ($is_default == "true"), urn: .urn}]
    ')"
    project_resources_json="$(jq -cn --argjson left "$project_resources_json" --argjson right "$project_rows" '$left + $right')"
  done <<EOF_PROJECTS
$(printf '%s' "$projects_json" | jq -r '(.projects // [])[]? | [.id, .name, (.is_default // false)] | @tsv')
EOF_PROJECTS

  droplet_project_failures="$(jq -rn \
    --argjson droplets "$droplets_json" \
    --argjson resources "$project_resources_json" \
    --argjson expected "$droplet_projects_json" '
    $expected[]
    | . as $want
    | ($droplets.droplets // [])[]? as $droplet
    | select($droplet.name == $want.name)
    | "do:droplet:\($droplet.id)" as $urn
    | select(any($resources[]?; .urn == $urn and .project == $want.project) | not)
    | "\($want.name)->\($want.project)"
  ')"
  if [ -n "$droplet_project_failures" ]; then
    fail "droplets are not in expected projects: $(printf '%s' "$droplet_project_failures" | paste -sd, -)"
  fi

  if [ "$require_default_project_empty" = "1" ]; then
    default_project_droplets="$(jq -rn \
      --argjson droplets "$droplets_json" \
      --argjson resources "$project_resources_json" '
      $resources[]
      | select(.is_default)
      | .urn as $urn
      | ($droplets.droplets // [])[]?
      | select("do:droplet:\(.id)" == $urn)
      | .name
    ')"
    if [ -n "$default_project_droplets" ]; then
      fail "default project still has droplets: $(printf '%s' "$default_project_droplets" | paste -sd, -)"
    fi
  fi
fi

if [ "$require_firewall_coverage" = "1" ]; then
  firewalls_json="$(api_get firewalls firewalls "/v2/firewalls?per_page=200")"
  log "checking DigitalOcean firewall coverage"
  uncovered_droplets="$(jq -rn \
    --argjson droplets "$droplets_json" \
    --argjson firewalls "$firewalls_json" \
    --argjson expected "$expected_droplets_json" '
    ($droplets.droplets // [])[]
    | select((.status // "") != "archive")
    | . as $droplet
    | select(($expected | length) == 0 or ($expected | index($droplet.name)))
    | ($droplet.tags // []) as $droplet_tags
    | select(any(($firewalls.firewalls // [])[]?;
        ((.droplet_ids // []) | index($droplet.id)) or
        ((.tags // []) | any(. as $tag | $droplet_tags | index($tag)))
      ) | not)
    | $droplet.name
  ')"
  if [ -n "$uncovered_droplets" ]; then
    fail "droplets have no firewall coverage: $(printf '%s' "$uncovered_droplets" | paste -sd, -)"
  fi
fi

if [ -n "$max_month_to_date_usage" ]; then
  balance_json="$(api_get_raw balance "/v2/customers/my/balance")"
  log "checking DigitalOcean spend"
  month_to_date_usage="$(printf '%s' "$balance_json" | jq -r '.month_to_date_usage // .month_to_date_balance // empty')"
  if [ -z "$month_to_date_usage" ] || ! [[ "$month_to_date_usage" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
    fail "DigitalOcean balance response did not include numeric month-to-date usage"
  elif ! awk -v usage="$month_to_date_usage" -v max="$max_month_to_date_usage" 'BEGIN { exit (usage <= max ? 0 : 1) }'; then
    fail "month-to-date DigitalOcean usage exceeds ${max_month_to_date_usage}: ${month_to_date_usage}"
  fi
fi

if [ "$failures" -gt 0 ]; then
  printf 'DigitalOcean account cleanup audit failed: %d failure(s)\n' "$failures" >&2
  exit 1
fi

printf 'DigitalOcean account cleanup audit passed\n'
