#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "${script_dir}/lib/digitalocean-pagination.sh"

api_url="${BOXHAVEN_DIGITALOCEAN_API_URL:-https://api.digitalocean.com}"
api_url="${api_url%/}"
token="${DIGITALOCEAN_ACCESS_TOKEN:-${DIGITALOCEAN_TOKEN:-${DO_API_TOKEN:-}}}"
boxhaven_tag="${BOXHAVEN_DO_FIREWALL_TAG:-boxhaven}"
firewall_names="${BOXHAVEN_DO_FIREWALL_NAMES:-}"
trusted_ssh_cidrs="${BOXHAVEN_TRUSTED_SSH_CIDRS:-}"
dry_run="${BOXHAVEN_DO_FIREWALL_DRY_RUN:-0}"
fixture_path="${BOXHAVEN_DO_FIREWALL_FIXTURE:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/ensure-digitalocean-firewalls.sh

Restricts SSH ingress on BoxHaven DigitalOcean firewalls to explicit trusted
CIDRs while leaving non-SSH rules unchanged. Requires DIGITALOCEAN_ACCESS_TOKEN,
DIGITALOCEAN_TOKEN, or DO_API_TOKEN with firewall read/update scopes.

Env:
  BOXHAVEN_TRUSTED_SSH_CIDRS=203.0.113.10/32,2001:db8::/64  # required
  BOXHAVEN_DO_FIREWALL_TAG=boxhaven
  BOXHAVEN_DO_FIREWALL_NAMES=baseline-public-web-ssh,boxhaven-user-boxes
  BOXHAVEN_DO_FIREWALL_DRY_RUN=1
  BOXHAVEN_DO_FIREWALL_FIXTURE=/path/to/firewalls.json
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

[ -n "$token" ] || {
  if [ -z "$fixture_path" ]; then
    printf 'set DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_TOKEN, DO_API_TOKEN, or BOXHAVEN_DO_FIREWALL_FIXTURE\n' >&2
    exit 2
  fi
}
if [ -n "$fixture_path" ] && [ "$dry_run" != "1" ]; then
  printf 'BOXHAVEN_DO_FIREWALL_FIXTURE requires BOXHAVEN_DO_FIREWALL_DRY_RUN=1\n' >&2
  exit 2
fi
[ -n "$trusted_ssh_cidrs" ] || {
  printf 'set BOXHAVEN_TRUSTED_SSH_CIDRS to one or more CIDRs before changing firewalls\n' >&2
  exit 2
}

trusted_json="$(printf '%s' "$trusted_ssh_cidrs" | csv_json_array)"
names_json="$(printf '%s' "$firewall_names" | csv_json_array)"
if [ -n "$fixture_path" ]; then
  firewalls_json="$(cat "$fixture_path")"
else
  firewalls_json="$(digitalocean_api_get_all firewalls "/v2/firewalls?per_page=200")"
fi

selected="$(printf '%s' "$firewalls_json" | jq -c --arg tag "$boxhaven_tag" --argjson names "$names_json" '
  .firewalls[]?
  | select(
      (($names | length) > 0 and ($names | index(.name))) or
      (($names | length) == 0 and ((.tags // []) | index($tag)))
    )
')"

if [ -z "$selected" ]; then
  printf 'no matching firewalls found\n' >&2
  exit 1
fi

changed=0
while IFS= read -r firewall; do
  [ -n "$firewall" ] || continue
  id="$(printf '%s' "$firewall" | jq -r '.id')"
  name="$(printf '%s' "$firewall" | jq -r '.name')"
  updated="$(printf '%s' "$firewall" | jq -c --argjson trusted "$trusted_json" '
    .inbound_rules = ((.inbound_rules // []) | map(
      if ((.protocol == "tcp" or .protocol == "all") and (.ports == "22" or .ports == "all")) then
        .sources.addresses = $trusted
      else
        .
      end
    ))
  ')"
  if [ "$(printf '%s' "$firewall" | jq -S '.')" = "$(printf '%s' "$updated" | jq -S '.')" ]; then
    printf 'firewall already restricted: %s\n' "$name"
    continue
  fi
  body="$(printf '%s' "$updated" | jq -c '{
    name,
    inbound_rules,
    outbound_rules,
    droplet_ids: (.droplet_ids // []),
    tags: (.tags // []),
    pending_changes: (.pending_changes // [])
  } | del(.pending_changes)')"
  if [ "$dry_run" = "1" ]; then
    printf 'would update firewall %s (%s): %s\n' "$name" "$id" "$body"
  else
    api PUT "/v2/firewalls/${id}" "$body" >/dev/null
    printf 'updated firewall SSH sources: %s\n' "$name"
  fi
  changed=$((changed + 1))
done <<< "$selected"

printf 'firewall restriction complete: %d update(s)%s\n' "$changed" "$([ "$dry_run" = "1" ] && printf ' planned' || true)"
