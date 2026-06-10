#!/usr/bin/env bash
# Local backend smoke: boots the real backend against a mock provider API and
# exercises auth, teams, and managed images over HTTP. Needs no cloud
# credentials and creates no cloud resources.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BOXHAVEN_SMOKE_BACKEND_PORT:-8791}"
MOCK_PORT="${BOXHAVEN_SMOKE_MOCK_PORT:-8792}"
STATE_DIR="$(mktemp -d)"
BACKEND_PID=""
MOCK_PID=""

cleanup() {
  [ -n "$BACKEND_PID" ] && { kill -- -"$BACKEND_PID" 2>/dev/null || kill "$BACKEND_PID" 2>/dev/null || true; }
  [ -n "$MOCK_PID" ] && { kill -- -"$MOCK_PID" 2>/dev/null || kill "$MOCK_PID" 2>/dev/null || true; }
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

log() { printf '\033[36m→ %s\033[0m\n' "$*"; }
pass() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

json() { python3 -c "import json,sys; data=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': data}))" "$1"; }

log "Starting mock Hetzner API on :$MOCK_PORT"
setsid env MOCK_PORT="$MOCK_PORT" node -e '
const http = require("http");
const images = [
  { id: 101, name: null, description: "boxhaven-remote-smoke-old", type: "snapshot", status: "available", created: "2026-01-01T00:00:00Z", image_size: 9.5, labels: { boxhaven: "" } },
  { id: 102, name: null, description: "boxhaven-remote-smoke-new", type: "snapshot", status: "available", created: "2026-02-01T00:00:00Z", image_size: 9.9, labels: { boxhaven: "" } },
];
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/v1/images") && req.method === "GET") {
    res.end(JSON.stringify({ images, meta: { pagination: { next_page: null } } }));
    return;
  }
  if (req.url.startsWith("/v1/images/") && req.method === "DELETE") {
    res.statusCode = 204;
    res.end();
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { code: "not_found", message: req.url } }));
}).listen(process.env.MOCK_PORT, "127.0.0.1");
' &
MOCK_PID=$!

TSX_BIN="$ROOT/backend/node_modules/.bin/tsx"
if [ ! -x "$TSX_BIN" ]; then
  fail "backend dependencies are not installed; run: npm --prefix backend ci"
fi

log "Starting backend on :$PORT (provider: mock hetzner)"
setsid env -u DIGITALOCEAN_ACCESS_TOKEN -u DIGITALOCEAN_TOKEN -u DO_API_TOKEN \
  BETTER_AUTH_SECRET="smoke-secret-with-at-least-32-bytes!!" \
  HCLOUD_TOKEN="smoke-token" \
  BOXHAVEN_HETZNER_API_URL="http://127.0.0.1:$MOCK_PORT/v1" \
  BOXHAVEN_BACKEND_LISTEN="127.0.0.1:$PORT" \
  BOXHAVEN_BACKEND_STATE="$STATE_DIR/backend.json" \
  BOXHAVEN_BACKEND_AUTH_DB="$STATE_DIR/auth.sqlite" \
  BOXHAVEN_SSH_CA_KEY="$STATE_DIR/ssh_ca_ed25519" \
  BOXHAVEN_ADMIN_EMAILS="admin@smoke.test" \
  BOXHAVEN_API_URL="http://127.0.0.1:$PORT" \
  "$TSX_BIN" "$ROOT/backend/src/index.ts" &
BACKEND_PID=$!

BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 150); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then fail "backend process exited during startup"; fi
  sleep 0.2
done
curl -fsS "$BASE/healthz" >/dev/null || fail "backend did not become healthy"
pass "backend is healthy"

PROVIDERS=$(curl -fsS "$BASE/v1/providers")
echo "$PROVIDERS" | json "d['providers'][0]['name']" | grep -qx hetzner || fail "expected hetzner provider, got: $PROVIDERS"
pass "providers list reports hetzner"

ADMIN_TOKEN=$(curl -fsS -X POST "$BASE/v1/auth/sign-up/email" -H 'content-type: application/json' \
  -d '{"email":"admin@smoke.test","password":"smoke-password-1","name":"admin"}' | json "d['token']")
MEMBER_TOKEN=$(curl -fsS -X POST "$BASE/v1/auth/sign-up/email" -H 'content-type: application/json' \
  -d '{"email":"member@smoke.test","password":"smoke-password-1","name":"member"}' | json "d['token']")
[ -n "$ADMIN_TOKEN" ] && [ -n "$MEMBER_TOKEN" ] || fail "sign-up did not return tokens"
pass "signed up two users"

WHOAMI=$(curl -fsS "$BASE/v1/auth/whoami" -H "authorization: Bearer $ADMIN_TOKEN")
echo "$WHOAMI" | json "d['admin']" | grep -qx True || fail "admin flag missing for admin user: $WHOAMI"
curl -fsS "$BASE/v1/auth/whoami" -H "authorization: Bearer $MEMBER_TOKEN" | json "d['admin']" | grep -qx False || fail "member should not be admin"
pass "whoami reports admin gating"

ORG_ID=$(curl -fsS -X POST "$BASE/v1/auth/organization/create" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Smoke Team","slug":"smoke-team"}' | json "d.get('id') or d['organization']['id']")
[ -n "$ORG_ID" ] || fail "organization create returned no id"
pass "created team $ORG_ID"

INVITE_ID=$(curl -fsS -X POST "$BASE/v1/auth/organization/invite-member" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d "{\"email\":\"member@smoke.test\",\"role\":\"member\",\"organizationId\":\"$ORG_ID\"}" | json "d['id']")
curl -fsS -X POST "$BASE/v1/auth/organization/accept-invitation" -H "authorization: Bearer $MEMBER_TOKEN" \
  -H 'content-type: application/json' -d "{\"invitationId\":\"$INVITE_ID\"}" >/dev/null
pass "invited and accepted member via link id"

ROLE=$(curl -fsS "$BASE/v1/orgs/$ORG_ID/machines" -H "authorization: Bearer $MEMBER_TOKEN" | json "d['role']")
[ "$ROLE" = "member" ] || fail "expected member role on org machines endpoint, got $ROLE"
pass "org machines endpoint enforces membership"

DENIED=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/images" -H "authorization: Bearer $MEMBER_TOKEN")
[ "$DENIED" = "403" ] || fail "non-admin image list should be 403, got $DENIED"
IMAGES=$(curl -fsS "$BASE/v1/images" -H "authorization: Bearer $ADMIN_TOKEN")
echo "$IMAGES" | json "len(d['images'])" | grep -qx 2 || fail "expected 2 images, got: $IMAGES"
pass "image list is admin-gated and reads provider snapshots"

curl -fsS -X POST "$BASE/v1/images/activate" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"provider":"hetzner","id":"102"}' >/dev/null
ACTIVE=$(curl -fsS "$BASE/v1/images" -H "authorization: Bearer $ADMIN_TOKEN" | json "[i['id'] for i in d['images'] if i['active']][0]")
[ "$ACTIVE" = "102" ] || fail "expected image 102 active, got $ACTIVE"
BLOCKED=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/v1/images/102?provider=hetzner" -H "authorization: Bearer $ADMIN_TOKEN")
[ "$BLOCKED" = "409" ] || fail "deleting the active image should be 409, got $BLOCKED"
curl -fsS -X POST "$BASE/v1/images/deactivate" -H "authorization: Bearer $ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"provider":"hetzner"}' >/dev/null
pass "image activate/deactivate lifecycle works"

pass "local backend smoke passed"
