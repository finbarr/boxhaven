#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-production-fixtures.XXXXXX")"

cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

cd "$repo_root"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  }
}

require_command jq
require_command bash

assert_contains() {
  local file="$1"
  local pattern="$2"
  grep -q "$pattern" "$file" || {
    printf 'expected %s to contain %s\n' "$file" "$pattern" >&2
    exit 1
  }
}

assert_not_contains() {
  local file="$1"
  local pattern="$2"
  if grep -q "$pattern" "$file"; then
    printf 'expected %s not to contain %s\n' "$file" "$pattern" >&2
    exit 1
  fi
}

firewalls_fixture="${tmpdir}/firewalls.json"
alerts_fixture="${tmpdir}/alert_policies.json"
uptime_fixture="${tmpdir}/uptime_checks.json"
audit_fixtures="${tmpdir}/audit"
prune_fixtures="${tmpdir}/prune"
mkdir -p "$audit_fixtures" "$prune_fixtures"

cat > "$firewalls_fixture" <<'JSON'
{
  "firewalls": [
    {
      "id": "fw-1",
      "name": "boxhaven-user-boxes",
      "tags": ["boxhaven"],
      "droplet_ids": [],
      "inbound_rules": [
        {
          "protocol": "tcp",
          "ports": "22",
          "sources": {"addresses": ["0.0.0.0/0", "::/0"]}
        },
        {
          "protocol": "tcp",
          "ports": "443",
          "sources": {"addresses": ["0.0.0.0/0", "::/0"]}
        }
      ],
      "outbound_rules": []
    }
  ]
}
JSON

BOXHAVEN_TRUSTED_SSH_CIDRS=203.0.113.10/32 \
BOXHAVEN_DO_FIREWALL_FIXTURE="$firewalls_fixture" \
BOXHAVEN_DO_FIREWALL_DRY_RUN=1 \
  scripts/ensure-digitalocean-firewalls.sh > "${tmpdir}/firewalls.out"
assert_contains "${tmpdir}/firewalls.out" "would update firewall boxhaven-user-boxes"
assert_contains "${tmpdir}/firewalls.out" "203.0.113.10/32"

cat > "$alerts_fixture" <<'JSON'
{"policies":[]}
JSON

BOXHAVEN_ALERT_EMAILS=ops@example.com \
BOXHAVEN_DO_ALERT_FIXTURE="$alerts_fixture" \
BOXHAVEN_DO_ALERT_DRY_RUN=1 \
  scripts/ensure-digitalocean-alerts.sh > "${tmpdir}/alerts.out"
assert_contains "${tmpdir}/alerts.out" "BoxHaven CPU above 80%"
assert_contains "${tmpdir}/alerts.out" "ops@example.com"

cat > "$uptime_fixture" <<'JSON'
{
  "checks": [
    {
      "id": "check-1",
      "name": "boxhaven-api",
      "target": "https://api.boxhaven.dev/healthz"
    }
  ]
}
JSON

BOXHAVEN_DO_UPTIME_FIXTURE="$uptime_fixture" \
BOXHAVEN_DO_UPTIME_DRY_RUN=1 \
BOXHAVEN_DO_UPTIME_TARGETS=https://api.boxhaven.dev/healthz,https://app.boxhaven.dev/healthz \
  scripts/ensure-digitalocean-uptime.sh > "${tmpdir}/uptime.out"
assert_contains "${tmpdir}/uptime.out" "uptime check already exists: https://api.boxhaven.dev/healthz"
assert_contains "${tmpdir}/uptime.out" "would create uptime check"
assert_contains "${tmpdir}/uptime.out" "https://app.boxhaven.dev/healthz"

cat > "${audit_fixtures}/droplets.json" <<'JSON'
{"droplets":[{"id":101,"name":"boxhaven-api","status":"active"}]}
JSON
cat > "${audit_fixtures}/firewalls.json" <<'JSON'
{
  "firewalls": [
    {
      "id": "fw-1",
      "name": "boxhaven-user-boxes",
      "tags": ["boxhaven"],
      "droplet_ids": [],
      "inbound_rules": [
        {
          "protocol": "tcp",
          "ports": "22",
          "sources": {"addresses": ["203.0.113.10/32"]}
        }
      ]
    }
  ]
}
JSON
cat > "${audit_fixtures}/alert_policies.json" <<'JSON'
{"policies":[{"uuid":"policy-1","description":"BoxHaven CPU above 80%"}]}
JSON
cat > "${audit_fixtures}/uptime_checks.json" <<'JSON'
{
  "checks": [
    {"id":"api","target":"https://api.boxhaven.dev/healthz"},
    {"id":"app","target":"https://app.boxhaven.dev/healthz"}
  ]
}
JSON
cat > "${audit_fixtures}/snapshots.json" <<'JSON'
{
  "snapshots": [
    {"id":"snap-active","name":"boxhaven-remote-active","created_at":"2026-05-30T00:00:00Z"}
  ]
}
JSON

BOXHAVEN_DO_AUDIT_FIXTURES="$audit_fixtures" \
BOXHAVEN_REMOTE_IMAGE=snap-active \
  scripts/digitalocean-production-audit.sh > "${tmpdir}/audit.out"
assert_contains "${tmpdir}/audit.out" "DigitalOcean production audit passed"

cat > "${prune_fixtures}/snapshots.json" <<'JSON'
{
  "snapshots": [
    {"id":"snap-old","name":"boxhaven-remote-old","created_at":"2026-04-01T00:00:00Z"},
    {"id":"snap-active","name":"boxhaven-remote-active","created_at":"2026-03-01T00:00:00Z"},
    {"id":"snap-new","name":"boxhaven-remote-new","created_at":"2026-05-30T00:00:00Z"},
    {"id":"other-old","name":"other-old","created_at":"2026-03-01T00:00:00Z"}
  ]
}
JSON

BOXHAVEN_DO_SNAPSHOT_PRUNE_FIXTURES="$prune_fixtures" \
BOXHAVEN_REMOTE_IMAGE=snap-active \
BOXHAVEN_DO_SNAPSHOT_KEEP_DAYS=30 \
  scripts/prune-digitalocean-snapshots.sh > "${tmpdir}/prune.out"
assert_contains "${tmpdir}/prune.out" "would delete snapshot snap-old"
assert_not_contains "${tmpdir}/prune.out" "snap-active"
assert_not_contains "${tmpdir}/prune.out" "snap-new"
assert_not_contains "${tmpdir}/prune.out" "other-old"

if BOXHAVEN_DO_SNAPSHOT_PRUNE_APPLY=1 \
  DIGITALOCEAN_ACCESS_TOKEN=test \
  BOXHAVEN_DIGITALOCEAN_API_URL=http://127.0.0.1:1 \
  scripts/prune-digitalocean-snapshots.sh > "${tmpdir}/prune-apply.out" 2> "${tmpdir}/prune-apply.err"; then
  printf 'snapshot prune apply unexpectedly succeeded without BOXHAVEN_REMOTE_IMAGE\n' >&2
  exit 1
fi
assert_contains "${tmpdir}/prune-apply.err" "set BOXHAVEN_REMOTE_IMAGE"

printf 'production fixture tests passed\n'
