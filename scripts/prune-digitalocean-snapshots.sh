#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${script_dir}/lib/digitalocean-pagination.sh"

api_url="${BOXHAVEN_DIGITALOCEAN_API_URL:-https://api.digitalocean.com}"
api_url="${api_url%/}"
token="${DIGITALOCEAN_ACCESS_TOKEN:-${DIGITALOCEAN_TOKEN:-${DO_API_TOKEN:-}}}"
fixtures_dir="${BOXHAVEN_DO_SNAPSHOT_PRUNE_FIXTURES:-}"
snapshot_prefix="${BOXHAVEN_DO_SNAPSHOT_PREFIX:-boxhaven-remote-}"
snapshot_ids="${BOXHAVEN_DO_SNAPSHOT_PRUNE_IDS:-}"
active_snapshot="${BOXHAVEN_REMOTE_IMAGE:-}"
keep_days="${BOXHAVEN_DO_SNAPSHOT_KEEP_DAYS:-30}"
apply="${BOXHAVEN_DO_SNAPSHOT_PRUNE_APPLY:-0}"

usage() {
  cat <<'EOF'
Usage:
  scripts/prune-digitalocean-snapshots.sh

Lists old non-active BoxHaven remote snapshots and, when explicitly enabled,
deletes them from DigitalOcean. Dry-run is the default.

Env:
  DIGITALOCEAN_ACCESS_TOKEN=...            # or DIGITALOCEAN_TOKEN / DO_API_TOKEN
  BOXHAVEN_REMOTE_IMAGE=<snapshot-id>      # active snapshot to keep
  BOXHAVEN_DO_SNAPSHOT_PREFIX=boxhaven-remote-
  BOXHAVEN_DO_SNAPSHOT_PRUNE_IDS=id1,id2  # optional explicit old manual snapshots
  BOXHAVEN_DO_SNAPSHOT_KEEP_DAYS=30
  BOXHAVEN_DO_SNAPSHOT_PRUNE_APPLY=0       # set to 1 to delete
  BOXHAVEN_DO_SNAPSHOT_PRUNE_FIXTURES=dir  # local tests; expects snapshots.json
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

api_get_snapshots() {
  if [ -n "$fixtures_dir" ]; then
    local fixture_path="${fixtures_dir}/snapshots.json"
    [ -f "$fixture_path" ] || {
      printf 'missing fixture: %s\n' "$fixture_path" >&2
      exit 2
    }
    cat "$fixture_path"
    return
  fi
  [ -n "$token" ] || {
    printf 'set DIGITALOCEAN_ACCESS_TOKEN or BOXHAVEN_DO_SNAPSHOT_PRUNE_FIXTURES\n' >&2
    exit 2
  }
  digitalocean_api_get_all snapshots "/v2/snapshots?resource_type=droplet&per_page=200"
}

api_delete_snapshot() {
  local snapshot_id="$1"
  curl -fsS -X DELETE -H "Authorization: Bearer ${token}" "${api_url}/v2/snapshots/${snapshot_id}" >/dev/null
}

require_command curl
require_command jq
require_command date

if [ "$apply" = "1" ] && [ -n "$fixtures_dir" ]; then
  printf 'refusing to apply deletes while using fixtures\n' >&2
  exit 2
fi
if [ "$apply" = "1" ] && [ -z "$token" ]; then
  printf 'set DIGITALOCEAN_ACCESS_TOKEN before applying deletes\n' >&2
  exit 2
fi
if [ "$apply" = "1" ] && [ -z "$active_snapshot" ]; then
  printf 'set BOXHAVEN_REMOTE_IMAGE to the active snapshot id before applying deletes\n' >&2
  exit 2
fi

now_epoch="$(date -u +%s)"
keep_seconds=$((keep_days * 24 * 60 * 60))
snapshots_json="$(api_get_snapshots)"
snapshot_ids_json="$(jq -cn --arg value "$snapshot_ids" '$value | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))')"

eligible="$(printf '%s' "$snapshots_json" | jq -r \
  --arg prefix "$snapshot_prefix" \
  --arg active "$active_snapshot" \
  --argjson explicit "$snapshot_ids_json" \
  --argjson now "$now_epoch" \
  --argjson keep "$keep_seconds" '
  .snapshots[]?
  | (.id | tostring) as $id
  | select($id != $active)
  | select(
      (($explicit | length) > 0 and ($explicit | index($id))) or
      (
        ((.name // "") | startswith($prefix)) and
        (.created_at != null) and
        (($now - ((.created_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601))) > $keep)
      )
    )
  | [.id, .name, .created_at] | @tsv
')"

if [ -z "$eligible" ]; then
  if [ -n "$snapshot_ids" ]; then
    printf 'no old non-active snapshots matched prefix %s or explicit ids %s\n' "$snapshot_prefix" "$snapshot_ids"
  else
    printf 'no old non-active snapshots matched prefix %s\n' "$snapshot_prefix"
  fi
  exit 0
fi

printf '%s\n' "$eligible" | while IFS="$(printf '\t')" read -r snapshot_id snapshot_name created_at; do
  if [ "$apply" = "1" ]; then
    printf 'deleting snapshot %s (%s, created %s)\n' "$snapshot_id" "$snapshot_name" "$created_at"
    api_delete_snapshot "$snapshot_id"
  else
    printf 'would delete snapshot %s (%s, created %s)\n' "$snapshot_id" "$snapshot_name" "$created_at"
  fi
done

if [ "$apply" != "1" ]; then
  printf 'dry-run only; set BOXHAVEN_DO_SNAPSHOT_PRUNE_APPLY=1 to delete\n'
fi
