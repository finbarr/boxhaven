#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-production-fixtures.XXXXXX")"
http_smoke_pid=""

cleanup() {
  if [ -n "$http_smoke_pid" ]; then
    kill "$http_smoke_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

cd "$repo_root"
. "${repo_root}/scripts/lib/digitalocean-pagination.sh"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  }
}

require_command jq
require_command bash
require_command python3
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

assert_contains_literal() {
  local file="$1"
  local pattern="$2"
  grep -Fq "$pattern" "$file" || {
    printf 'expected %s to contain literal %s\n' "$file" "$pattern" >&2
    exit 1
  }
}

firewalls_fixture="${tmpdir}/firewalls.json"
alerts_fixture="${tmpdir}/alert_policies.json"
uptime_fixture="${tmpdir}/uptime_checks.json"
audit_fixtures="${tmpdir}/audit"
account_audit_fixtures="${tmpdir}/account-audit"
prune_fixtures="${tmpdir}/prune"
pagination_dir="${tmpdir}/pagination"
backup_root="${tmpdir}/backups"
storage_audit_root="${tmpdir}/storage-audit"
data_root="${tmpdir}/data"
good_env="${tmpdir}/good.env"
bad_env="${tmpdir}/bad.env"
malicious_env="${tmpdir}/malicious.env"
malicious_marker="${tmpdir}/malicious-marker"
release_dir="${tmpdir}/release"
bad_release_dir="${tmpdir}/bad-release"
mkdir -p "$audit_fixtures" "$account_audit_fixtures" "$prune_fixtures" "$pagination_dir" "$storage_audit_root"

cat > "${pagination_dir}/snapshots-page-1.json" <<EOF_JSON
{
  "snapshots": [{"id":"snap-page-1","name":"boxhaven-remote-page-1"}],
  "links": {"pages": {"next": "file://${pagination_dir}/snapshots-page-2.json"}}
}
EOF_JSON
cat > "${pagination_dir}/snapshots-page-2.json" <<'JSON'
{
  "snapshots": [{"id":"snap-page-2","name":"boxhaven-remote-page-2"}],
  "links": {"pages": {}}
}
JSON

token=test \
api_url="file://${pagination_dir}" \
  digitalocean_api_get_all snapshots "/snapshots-page-1.json" > "${tmpdir}/pagination.out"
test "$(jq -r '.snapshots | length' "${tmpdir}/pagination.out")" = "2"
assert_contains "${tmpdir}/pagination.out" "snap-page-1"
assert_contains "${tmpdir}/pagination.out" "snap-page-2"
assert_contains_literal deploy/digitalocean/build-remote-image.sh "created_builder_ssh_key_id="
assert_contains_literal deploy/digitalocean/build-remote-image.sh "do_api DELETE \"/v2/account/keys/\${created_builder_ssh_key_id}\""

cat > "${tmpdir}/http-smoke-server.py" <<'PY'
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys

port_file = sys.argv[1]
token = sys.argv[2]

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok\n")
            return
        if self.path == "/metrics":
            if self.headers.get("Authorization") != f"Bearer {token}":
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b"unauthorized\n")
                return
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"boxhaven_machines 1\n")
            return
        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        return

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w", encoding="utf-8") as handle:
    handle.write(str(server.server_port))
server.serve_forever()
PY
http_smoke_port_file="${tmpdir}/http-smoke-port"
python3 "${tmpdir}/http-smoke-server.py" "$http_smoke_port_file" "metrics-token-0123456789abcdef" &
http_smoke_pid="$!"
for _ in $(seq 1 50); do
  [ -s "$http_smoke_port_file" ] && break
  sleep 0.1
done
test -s "$http_smoke_port_file"
http_smoke_url="http://127.0.0.1:$(cat "$http_smoke_port_file")"
BOXHAVEN_PRODUCTION_API_URL="$http_smoke_url" \
BOXHAVEN_PRODUCTION_APP_URL="$http_smoke_url" \
BOXHAVEN_METRICS_BEARER_TOKEN=metrics-token-0123456789abcdef \
  scripts/smoke-production-http.sh > "${tmpdir}/http-smoke.out"
assert_contains "${tmpdir}/http-smoke.out" "production HTTP smoke passed"

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
{
  "policies": [
    {"uuid":"wrong-tag","description":"BoxHaven CPU above 80%","tags":["other"]}
  ]
}
JSON

BOXHAVEN_ALERT_EMAILS=ops@example.com \
BOXHAVEN_DO_ALERT_FIXTURE="$alerts_fixture" \
BOXHAVEN_DO_ALERT_DRY_RUN=1 \
  scripts/ensure-digitalocean-alerts.sh > "${tmpdir}/alerts.out"
assert_contains "${tmpdir}/alerts.out" "BoxHaven CPU above 80%"
assert_contains "${tmpdir}/alerts.out" "ops@example.com"
assert_contains "${tmpdir}/alerts.out" '"tags":\["boxhaven"\]'

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
{
  "policies": [
    {"uuid":"ignored","description":"BoxHaven CPU above 80%","tags":["other"],"type":"v1/insights/droplet/cpu","value":80,"compare":"GreaterThan","enabled":true},
    {"uuid":"disabled","description":"BoxHaven memory above 90%","tags":["boxhaven"],"type":"v1/insights/droplet/memory_utilization_percent","value":90,"compare":"GreaterThan","enabled":false},
    {"uuid":"policy-1","description":"BoxHaven CPU above 80%","tags":["boxhaven"],"type":"v1/insights/droplet/cpu","value":80,"compare":"GreaterThan","enabled":true},
    {"uuid":"policy-2","description":"BoxHaven memory above 90%","tags":["boxhaven"],"type":"v1/insights/droplet/memory_utilization_percent","value":90,"compare":"GreaterThan","enabled":true},
    {"uuid":"policy-3","description":"BoxHaven disk above 85%","tags":["boxhaven"],"type":"v1/insights/droplet/disk_utilization_percent","value":85,"compare":"GreaterThan","enabled":true}
  ]
}
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
    {"id":"snap-active","name":"custom-remote-active","created_at":"2026-05-30T00:00:00Z"},
    {"id":"other-snap","name":"boxhaven-remote-ignored","created_at":"2026-05-30T00:00:00Z"}
  ]
}
JSON

BOXHAVEN_DO_AUDIT_FIXTURES="$audit_fixtures" \
BOXHAVEN_DO_AUDIT_SNAPSHOT_PREFIX=custom-remote- \
BOXHAVEN_REMOTE_IMAGE=snap-active \
  scripts/digitalocean-production-audit.sh > "${tmpdir}/audit.out"
assert_contains "${tmpdir}/audit.out" "DigitalOcean production audit passed"
BOXHAVEN_DO_AUDIT_FIXTURES="$audit_fixtures" \
BOXHAVEN_DO_AUDIT_SNAPSHOT_PREFIX=custom-remote- \
  scripts/digitalocean-production-audit.sh > "${tmpdir}/audit-missing-image.out" 2> "${tmpdir}/audit-missing-image.err" && {
    printf 'DigitalOcean audit unexpectedly succeeded without BOXHAVEN_REMOTE_IMAGE\n' >&2
    exit 1
  }
assert_contains "${tmpdir}/audit-missing-image.err" "set BOXHAVEN_REMOTE_IMAGE"
BOXHAVEN_DO_AUDIT_FIXTURES="$audit_fixtures" \
BOXHAVEN_DO_AUDIT_SNAPSHOT_PREFIX=custom-remote- \
BOXHAVEN_REMOTE_IMAGE=other-snap \
  scripts/digitalocean-production-audit.sh > "${tmpdir}/audit-wrong-image.out" 2> "${tmpdir}/audit-wrong-image.err" && {
    printf 'DigitalOcean audit unexpectedly accepted non-BoxHaven active image\n' >&2
    exit 1
  }
assert_contains "${tmpdir}/audit-wrong-image.err" "does not match prefix"

cat > "${account_audit_fixtures}/droplets.json" <<'JSON'
{
  "droplets": [
    {"id":101,"name":"boxhaven-control-prod-nyc3-01","status":"active","created_at":"2026-06-01T00:00:00Z"},
    {"id":102,"name":"fundy-prod-nyc3-01","status":"active","created_at":"2026-06-01T00:00:00Z"},
    {"id":103,"name":"web","status":"active","created_at":"2015-01-01T00:00:00Z"}
  ]
}
JSON
cat > "${account_audit_fixtures}/snapshots.json" <<'JSON'
{
  "snapshots": [
    {"id":"160948396","name":"web-1721476164359","created_at":"2024-07-20T00:00:00Z"},
    {"id":"230979614","name":"boxhaven-remote-active","created_at":"2026-06-01T00:00:00Z"}
  ]
}
JSON
cat > "${account_audit_fixtures}/projects.json" <<'JSON'
{
  "projects": [
    {"id":"project-default","name":"Default","is_default":true},
    {"id":"project-boxhaven","name":"boxhaven","is_default":false},
    {"id":"project-fundy","name":"fundy","is_default":false},
    {"id":"project-legacy","name":"legacy","is_default":false}
  ]
}
JSON
cat > "${account_audit_fixtures}/project_resources_Default.json" <<'JSON'
{"resources":[{"urn":"do:droplet:103"}]}
JSON
cat > "${account_audit_fixtures}/project_resources_boxhaven.json" <<'JSON'
{"resources":[{"urn":"do:droplet:101"}]}
JSON
cat > "${account_audit_fixtures}/project_resources_fundy.json" <<'JSON'
{"resources":[{"urn":"do:droplet:102"}]}
JSON
cat > "${account_audit_fixtures}/project_resources_legacy.json" <<'JSON'
{"resources":[]}
JSON
BOXHAVEN_DO_ACCOUNT_AUDIT_FIXTURES="$account_audit_fixtures" \
BOXHAVEN_DO_ACCOUNT_EXPECTED_DROPLETS=boxhaven-control-prod-nyc3-01,fundy-prod-nyc3-01 \
BOXHAVEN_DO_ACCOUNT_CLEANUP_DROPLETS=web \
BOXHAVEN_DO_ACCOUNT_CLEANUP_SNAPSHOT_IDS=160948396 \
BOXHAVEN_DO_ACCOUNT_EXPECTED_PROJECTS=boxhaven,fundy,legacy \
BOXHAVEN_DO_ACCOUNT_DROPLET_PROJECTS=boxhaven-control-prod-nyc3-01=boxhaven,fundy-prod-nyc3-01=fundy,web=legacy \
BOXHAVEN_DO_ACCOUNT_REQUIRE_DEFAULT_PROJECT_EMPTY=1 \
  scripts/digitalocean-account-cleanup-audit.sh > "${tmpdir}/account-audit-bad.out" 2> "${tmpdir}/account-audit-bad.err" && {
    printf 'DigitalOcean account cleanup audit unexpectedly accepted cleanup fixtures\n' >&2
    exit 1
  }
assert_contains "${tmpdir}/account-audit-bad.err" "unexpected active droplets found: web"
assert_contains "${tmpdir}/account-audit-bad.err" "cleanup droplets still exist: web"
assert_contains "${tmpdir}/account-audit-bad.err" "cleanup snapshots still exist: 160948396"
assert_contains "${tmpdir}/account-audit-bad.err" "droplets are not in expected projects: web->legacy"
assert_contains "${tmpdir}/account-audit-bad.err" "default project still has droplets: web"
cat > "${account_audit_fixtures}/droplets.json" <<'JSON'
{
  "droplets": [
    {"id":101,"name":"boxhaven-control-prod-nyc3-01","status":"active","created_at":"2026-06-01T00:00:00Z"},
    {"id":102,"name":"fundy-prod-nyc3-01","status":"active","created_at":"2026-06-01T00:00:00Z"}
  ]
}
JSON
cat > "${account_audit_fixtures}/snapshots.json" <<'JSON'
{
  "snapshots": [
    {"id":"230979614","name":"boxhaven-remote-active","created_at":"2026-06-01T00:00:00Z"}
  ]
}
JSON
cat > "${account_audit_fixtures}/project_resources_Default.json" <<'JSON'
{"resources":[]}
JSON
BOXHAVEN_DO_ACCOUNT_AUDIT_FIXTURES="$account_audit_fixtures" \
BOXHAVEN_DO_ACCOUNT_EXPECTED_DROPLETS=boxhaven-control-prod-nyc3-01,fundy-prod-nyc3-01 \
BOXHAVEN_DO_ACCOUNT_CLEANUP_DROPLETS=web \
BOXHAVEN_DO_ACCOUNT_CLEANUP_SNAPSHOT_IDS=160948396 \
BOXHAVEN_DO_ACCOUNT_EXPECTED_PROJECTS=boxhaven,fundy,legacy \
BOXHAVEN_DO_ACCOUNT_DROPLET_PROJECTS=boxhaven-control-prod-nyc3-01=boxhaven,fundy-prod-nyc3-01=fundy \
BOXHAVEN_DO_ACCOUNT_REQUIRE_DEFAULT_PROJECT_EMPTY=1 \
  scripts/digitalocean-account-cleanup-audit.sh > "${tmpdir}/account-audit-good.out"
assert_contains "${tmpdir}/account-audit-good.out" "DigitalOcean account cleanup audit passed"

mkdir -p "${storage_audit_root}/fundy"
printf 'backup-one\n' > "${storage_audit_root}/fundy/one.tar.gz"
printf 'backup-two\n' > "${storage_audit_root}/fundy/two.tar.gz"
BOXHAVEN_BACKUP_STORAGE_TARGETS="fundy=${storage_audit_root}/fundy" \
BOXHAVEN_BACKUP_STORAGE_MAX_GIB=1 \
BOXHAVEN_BACKUP_STORAGE_MAX_FILES=1 \
  scripts/backup-storage-audit.sh > "${tmpdir}/storage-audit-bad.out" 2> "${tmpdir}/storage-audit-bad.err" && {
    printf 'backup storage audit unexpectedly accepted too many backups\n' >&2
    exit 1
  }
assert_contains "${tmpdir}/storage-audit-bad.err" "backup path exceeds 1 files"
BOXHAVEN_BACKUP_STORAGE_TARGETS="fundy=${storage_audit_root}/fundy" \
BOXHAVEN_BACKUP_STORAGE_MAX_GIB=1 \
BOXHAVEN_BACKUP_STORAGE_MAX_FILES=3 \
  scripts/backup-storage-audit.sh > "${tmpdir}/storage-audit-good.out"
assert_contains "${tmpdir}/storage-audit-good.out" "backup storage audit passed"

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

BOXHAVEN_DO_SNAPSHOT_PRUNE_FIXTURES="$prune_fixtures" \
BOXHAVEN_DO_SNAPSHOT_PRUNE_IDS=other-old,snap-active \
BOXHAVEN_REMOTE_IMAGE=snap-active \
BOXHAVEN_DO_SNAPSHOT_KEEP_DAYS=30 \
  scripts/prune-digitalocean-snapshots.sh > "${tmpdir}/prune-explicit.out"
assert_contains "${tmpdir}/prune-explicit.out" "would delete snapshot other-old"
assert_not_contains "${tmpdir}/prune-explicit.out" "snap-active"

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
BOXHAVEN_BACKUP_ROOT="$backup_root" \
BOXHAVEN_DATA_ROOT="${tmpdir}/missing-data" \
  deploy/digitalocean/backup-backend.sh > "${tmpdir}/backup-bad.out" 2> "${tmpdir}/backup-bad.err" && {
    printf 'backup unexpectedly succeeded without required backend files\n' >&2
    exit 1
  }
assert_contains "${tmpdir}/backup-bad.err" "backup is missing required file"
if find "$backup_root" -maxdepth 1 -type f -name 'boxhaven-backend-*.tar.gz' | grep -qvFx "$archive"; then
  printf 'failed backup left an unverified archive behind\n' >&2
  exit 1
fi
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
BOXHAVEN_METRICS_BEARER_TOKEN=metrics-token-0123456789abcdef
BOXHAVEN_SIGNUP_MODE=invite
BOXHAVEN_SIGNUP_INVITE_CODES=invite-code-1
DIGITALOCEAN_ACCESS_TOKEN=dop_v1_live_token_shape
BOXHAVEN_REMOTE_IMAGE=230979614
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
BOXHAVEN_METRICS_BEARER_TOKEN=replace-with-a-random-metrics-token
BOXHAVEN_SIGNUP_MODE=open
BOXHAVEN_SIGNUP_INVITE_CODES=replace-with-one-or-more-comma-separated-invite-codes
DIGITALOCEAN_ACCESS_TOKEN=dop_v1_example
BOXHAVEN_REMOTE_IMAGE=replace-with-active-boxhaven-remote-snapshot-id
EOF_ENV
if scripts/validate-production-env.sh --env-file "$bad_env" > "${tmpdir}/env-bad.out" 2> "${tmpdir}/env-bad.err"; then
  printf 'bad production env unexpectedly passed validation\n' >&2
  exit 1
fi
assert_contains "${tmpdir}/env-bad.err" "BOXHAVEN_SIGNUP_MODE must be invite or disabled"
assert_contains "${tmpdir}/env-bad.err" "DIGITALOCEAN_ACCESS_TOKEN still looks like a placeholder"
assert_contains "${tmpdir}/env-bad.err" "BOXHAVEN_REMOTE_IMAGE still looks like a placeholder"
if scripts/validate-production-compose.sh --env-file "$bad_env" > "${tmpdir}/compose-bad.out" 2> "${tmpdir}/compose-bad.err"; then
  printf 'bad production compose unexpectedly passed validation\n' >&2
  exit 1
fi
assert_contains "${tmpdir}/compose-bad.err" "production env validation failed"

cat > "$malicious_env" <<EOF_ENV
ACME_EMAIL=ops@boxhaven.dev
BOXHAVEN_APP_HOST=app.boxhaven.dev
BOXHAVEN_API_HOST=api.boxhaven.dev
BOXHAVEN_PREVIEW_BASE_DOMAIN=at.boxhaven.dev
BOXHAVEN_APP_URL=https://app.boxhaven.dev
BOXHAVEN_API_URL=https://api.boxhaven.dev
BETTER_AUTH_URL=https://api.boxhaven.dev/v1/auth
BETTER_AUTH_TRUSTED_ORIGINS=https://app.boxhaven.dev,https://api.boxhaven.dev
BOXHAVEN_BACKEND_CORS_ORIGINS=https://app.boxhaven.dev,https://api.boxhaven.dev
BETTER_AUTH_SECRET=\$(touch "$malicious_marker")
BOXHAVEN_METRICS_BEARER_TOKEN=metrics-token-0123456789abcdef
BOXHAVEN_SIGNUP_MODE=invite
BOXHAVEN_SIGNUP_INVITE_CODES=invite-code-1
DIGITALOCEAN_ACCESS_TOKEN=dop_v1_live_token_shape
BOXHAVEN_REMOTE_IMAGE=230979614
EOF_ENV
if scripts/validate-production-env.sh --env-file "$malicious_env" > "${tmpdir}/env-malicious.out" 2> "${tmpdir}/env-malicious.err"; then
  printf 'malicious production env unexpectedly passed validation\n' >&2
  exit 1
fi
if [ -e "$malicious_marker" ]; then
  printf 'production env validator executed env file content\n' >&2
  exit 1
fi
assert_contains "${tmpdir}/env-malicious.err" "BETTER_AUTH_SECRET must be a literal value"

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

mkdir -p "${bad_release_dir}"
cp "${release_dir}/boxhaven-vfixture-linux-amd64.tar.gz" "${bad_release_dir}/boxhaven-vfixture-linux-amd64.tar.gz"
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "boxhaven-vfixture-linux-amd64.tar.gz" > "${bad_release_dir}/checksums-vfixture.txt"
if BOXHAVEN_INSTALL_VERSION=vfixture \
  BOXHAVEN_INSTALL_BASE_URL="file://${bad_release_dir}" \
  BOXHAVEN_INSTALL_OS=linux \
  BOXHAVEN_INSTALL_ARCH=amd64 \
  BOXHAVEN_INSTALL_CHECKSUM_TOOL=shasum \
  BOXHAVEN_INSTALL_DIR="${tmpdir}/bad-install-bin" \
  scripts/install-bh.sh > "${tmpdir}/install-bad.out" 2> "${tmpdir}/install-bad.err"; then
  printf 'installer unexpectedly accepted a bad checksum\n' >&2
  exit 1
fi
if [ -e "${tmpdir}/bad-install-bin/bh" ]; then
  printf 'installer wrote bh despite checksum failure\n' >&2
  exit 1
fi

printf 'production fixture tests passed\n'
