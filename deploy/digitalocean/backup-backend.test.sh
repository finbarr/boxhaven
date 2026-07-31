#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup_script="${script_dir}/backup-backend.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

fail() {
  echo "backup-backend test: $*" >&2
  exit 1
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected output to contain '${2}', got: ${1}" ;;
  esac
}

assert_fails_without_archive() {
  local root="$1"
  local expected="$2"
  local output
  if output="$(run_backup "$root" 2>&1)"; then
    fail "expected backup to fail for ${root}"
  fi
  assert_contains "$output" "$expected"
  [ -z "$(find "${root}/backups" -maxdepth 1 -name 'boxhaven-backend-*.tar.gz' -print -quit)" ] \
    || fail "failed backup published an archive for ${root}"
}

make_fixture() {
  local root="$1"
  mkdir -p "${root}/data/backend" "${root}/data/caddy/data" "${root}/backups"
  printf '%s\n' '{"version":1,"provider":"digitalocean","machines":{}}' \
    > "${root}/data/backend/backend.json"
  sqlite3 "${root}/data/backend/auth.sqlite" \
    "CREATE TABLE session (id TEXT PRIMARY KEY, user_id TEXT NOT NULL); INSERT INTO session VALUES ('session-1', 'user-1');"
  ssh-keygen -q -t ed25519 -N '' -C boxhaven-remote-user-ca \
    -f "${root}/data/backend/ssh_ca_ed25519"
  printf '%s\n' 'caddy-state' > "${root}/data/caddy/data/state"
  printf '%s\n' 'must-not-be-copied' > "${root}/data/backend/auth.sqlite-wal"
  printf '%s\n' 'must-not-be-copied' > "${root}/data/backend/auth.sqlite-shm"
}

run_backup() {
  local root="$1"
  BOXHAVEN_DATA_ROOT="${root}/data" \
    BOXHAVEN_BACKUP_ROOT="${root}/backups" \
    BOXHAVEN_BACKUP_RETENTION_DAYS=14 \
    "$backup_script"
}

main_root="${temp_dir}/main"
make_fixture "$main_root"
archive="$(run_backup "$main_root")"
[ -f "$archive" ] || fail "backup did not create an archive"
[ -z "$(find "${main_root}/backups" -maxdepth 1 -name '.tmp-boxhaven-backend.*' -print -quit)" ] \
  || fail "backup left temporary files behind"

inventory="$(tar -tzf "$archive")"
for member in auth.sqlite backend.json ssh_ca_ed25519 ssh_ca_ed25519.pub caddy-data.tar.gz; do
  assert_contains "$inventory" "./${member}"
done
case "$inventory" in
  *auth.sqlite-wal*|*auth.sqlite-shm*) fail "backup included live SQLite sidecar files" ;;
esac

extracted="${temp_dir}/extracted"
mkdir "$extracted"
tar -C "$extracted" -xzf "$archive"
[ "$(sqlite3 "${extracted}/auth.sqlite" "SELECT user_id FROM session WHERE id = 'session-1';")" = "user-1" ] \
  || fail "SQLite online backup did not preserve data"
jq -e 'type == "object"' "${extracted}/backend.json" >/dev/null \
  || fail "archived backend state is invalid"
derived_public="$(ssh-keygen -y -f "${extracted}/ssh_ca_ed25519" | awk 'NF >= 2 { print $1 " " $2; exit }')"
stored_public="$(awk 'NF >= 2 { print $1 " " $2; exit }' "${extracted}/ssh_ca_ed25519.pub")"
[ "$derived_public" = "$stored_public" ] \
  || fail "archived SSH CA keys do not match"

for missing in auth.sqlite backend.json ssh_ca_ed25519 ssh_ca_ed25519.pub; do
  root="${temp_dir}/missing-${missing}"
  make_fixture "$root"
  rm "${root}/data/backend/${missing}"
  assert_fails_without_archive "$root" "required"
done

invalid_json_root="${temp_dir}/invalid-json"
make_fixture "$invalid_json_root"
printf '%s\n' 'not JSON' > "${invalid_json_root}/data/backend/backend.json"
assert_fails_without_archive "$invalid_json_root" "not a JSON object"

mismatch_root="${temp_dir}/mismatched-ca"
make_fixture "$mismatch_root"
ssh-keygen -q -t ed25519 -N '' -f "${mismatch_root}/different"
cp "${mismatch_root}/different.pub" "${mismatch_root}/data/backend/ssh_ca_ed25519.pub"
assert_fails_without_archive "$mismatch_root" "do not match"

invalid_db_root="${temp_dir}/invalid-db"
make_fixture "$invalid_db_root"
printf '%s\n' 'not SQLite' > "${invalid_db_root}/data/backend/auth.sqlite"
assert_fails_without_archive "$invalid_db_root" "file is not a database"

echo "backup integrity tests passed"
