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
require_command ssh-keygen
require_command tar

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
backup_root="${tmpdir}/backups"
data_root="${tmpdir}/data"
good_env="${tmpdir}/good.env"
bad_env="${tmpdir}/bad.env"
release_dir="${tmpdir}/release"
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

mkdir -p "${data_root}/backend" "${data_root}/caddy/data"
printf '{"machines":[]}\n' > "${data_root}/backend/backend.json"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${data_root}/backend/auth.sqlite" 'CREATE TABLE users (id TEXT PRIMARY KEY);'
else
  printf 'sqlite unavailable in fixture environment\n' > "${data_root}/backend/auth.sqlite"
fi
ssh-keygen -q -t ed25519 -N '' -f "${data_root}/backend/ssh_ca_ed25519"
printf 'caddy fixture\n' > "${data_root}/caddy/data/fixture.txt"

archive="$(
  BOXHAVEN_BACKUP_ROOT="$backup_root" \
  BOXHAVEN_DATA_ROOT="$data_root" \
  deploy/digitalocean/backup-backend.sh
)"
test -f "$archive"
test "$(stat -c '%a' "$archive" 2>/dev/null || stat -f '%Lp' "$archive")" = "600"
scripts/verify-backend-backup-restore.sh "$archive" > "${tmpdir}/backup.out"
assert_contains "${tmpdir}/backup.out" "backup restore verification passed"

cat > "$good_env" <<'EOF_ENV'
ACME_EMAIL=ops@boxhaven.dev
BOXHAVEN_APP_HOST=app.boxhaven.dev
BOXHAVEN_API_HOST=api.boxhaven.dev
BOXHAVEN_PREVIEW_BASE_DOMAIN=at.boxhaven.dev
BOXHAVEN_APP_URL=https://app.boxhaven.dev
BOXHAVEN_API_URL=https://api.boxhaven.dev
BETTER_AUTH_URL=https://api.boxhaven.dev/v1/auth
BETTER_AUTH_TRUSTED_ORIGINS=https://app.boxhaven.dev,https://api.boxhaven.dev
BOXHAVEN_BACKEND_CORS_ORIGINS=https://app.boxhaven.dev,https://api.boxhaven.dev
BETTER_AUTH_SECRET=0123456789abcdef0123456789abcdef
BOXHAVEN_SIGNUP_MODE=invite
BOXHAVEN_SIGNUP_INVITE_CODES=invite-code-1
DIGITALOCEAN_ACCESS_TOKEN=dop_v1_live_token_shape
EOF_ENV
scripts/validate-production-env.sh --env-file "$good_env" > "${tmpdir}/env-good.out"
assert_contains "${tmpdir}/env-good.out" "production env validation passed"
scripts/validate-production-compose.sh --env-file "$good_env" > "${tmpdir}/compose-good.out"
assert_contains "${tmpdir}/compose-good.out" "production compose validation passed"

cat > "$bad_env" <<'EOF_ENV'
ACME_EMAIL=admin@example.com
BOXHAVEN_APP_HOST=app.boxhaven.dev
BOXHAVEN_API_HOST=api.boxhaven.dev
BOXHAVEN_PREVIEW_BASE_DOMAIN=at.boxhaven.dev
BOXHAVEN_APP_URL=https://app.boxhaven.dev
BOXHAVEN_API_URL=https://api.boxhaven.dev
BETTER_AUTH_URL=https://api.boxhaven.dev/v1/auth
BETTER_AUTH_TRUSTED_ORIGINS=https://app.boxhaven.dev,https://api.boxhaven.dev
BOXHAVEN_BACKEND_CORS_ORIGINS=https://app.boxhaven.dev,https://api.boxhaven.dev
BETTER_AUTH_SECRET=replace-with-a-random-secret-at-least-32-bytes
BOXHAVEN_SIGNUP_MODE=open
BOXHAVEN_SIGNUP_INVITE_CODES=replace-with-one-or-more-comma-separated-invite-codes
DIGITALOCEAN_ACCESS_TOKEN=dop_v1_example
EOF_ENV
if scripts/validate-production-env.sh --env-file "$bad_env" > "${tmpdir}/env-bad.out" 2> "${tmpdir}/env-bad.err"; then
  printf 'bad production env unexpectedly passed validation\n' >&2
  exit 1
fi
assert_contains "${tmpdir}/env-bad.err" "BOXHAVEN_SIGNUP_MODE must be invite or disabled"
assert_contains "${tmpdir}/env-bad.err" "DIGITALOCEAN_ACCESS_TOKEN still looks like a placeholder"
if scripts/validate-production-compose.sh --env-file "$bad_env" > "${tmpdir}/compose-bad.out" 2> "${tmpdir}/compose-bad.err"; then
  printf 'bad production compose unexpectedly passed validation\n' >&2
  exit 1
fi
assert_contains "${tmpdir}/compose-bad.err" "production env validation failed"

if BOXHAVEN_SMOKE_PRODUCTION=1 scripts/smoke-remote-lifecycle.sh > "${tmpdir}/smoke-preflight.out" 2> "${tmpdir}/smoke-preflight.err"; then
  printf 'production smoke unexpectedly passed without credentials\n' >&2
  exit 1
fi
assert_contains "${tmpdir}/smoke-preflight.err" "requires BOXHAVEN_TOKEN"

mkdir -p "${release_dir}/work" "${tmpdir}/install-bin"
cat > "${release_dir}/work/bh" <<'EOF_BH'
#!/usr/bin/env sh
printf 'bh fixture-version\n'
EOF_BH
chmod +x "${release_dir}/work/bh"
tar -C "${release_dir}/work" -czf "${release_dir}/boxhaven-vfixture-linux-amd64.tar.gz" bh
(cd "$release_dir" && sha256sum boxhaven-vfixture-linux-amd64.tar.gz > checksums-vfixture.txt)
BOXHAVEN_INSTALL_VERSION=vfixture \
BOXHAVEN_INSTALL_BASE_URL="file://${release_dir}" \
BOXHAVEN_INSTALL_OS=linux \
BOXHAVEN_INSTALL_ARCH=amd64 \
BOXHAVEN_INSTALL_CHECKSUM_TOOL=shasum \
BOXHAVEN_INSTALL_DIR="${tmpdir}/install-bin" \
  scripts/install-bh.sh > "${tmpdir}/install.out"
assert_contains "${tmpdir}/install.out" "bh fixture-version"
test -x "${tmpdir}/install-bin/bh"

printf 'production fixture tests passed\n'
