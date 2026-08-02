#!/usr/bin/env bash
set -euo pipefail
umask 077

backup_root="${BOXHAVEN_BACKUP_ROOT:-/opt/boxhaven/backups}"
data_root="${BOXHAVEN_DATA_ROOT:-/opt/boxhaven/data}"
retention_days="${BOXHAVEN_BACKUP_RETENTION_DAYS:-14}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive="${backup_root}/boxhaven-backend-${timestamp}.tar.gz"

fail() {
  echo "boxhaven backend backup: $*" >&2
  exit 1
}

require_file() {
  local path="$1"
  local label="$2"
  [ -f "$path" ] && [ ! -L "$path" ] && [ -s "$path" ] \
    || fail "required ${label} is missing or invalid: ${path}"
}

backend_dir="${data_root}/backend"
caddy_dir="${data_root}/caddy"
database="${backend_dir}/boxhaven.sqlite"
ca_private="${backend_dir}/ssh_ca_ed25519"
ca_public="${backend_dir}/ssh_ca_ed25519.pub"

require_file "$database" "BoxHaven SQLite database"
require_file "$ca_private" "SSH CA private key"
require_file "$ca_public" "SSH CA public key"

mkdir -p "${backup_root}"
[ ! -e "$archive" ] || fail "refusing to overwrite existing archive: ${archive}"

tmpdir="$(mktemp -d "${backup_root}/.tmp-boxhaven-backend.XXXXXX")"
staging="${tmpdir}/staging"
temporary_archive="${tmpdir}/archive.tar.gz"
mkdir "${staging}"

cleanup() {
  rm -rf "${tmpdir}"
}
trap cleanup EXIT

sqlite3 "$database" ".backup '${staging}/boxhaven.sqlite'"
install -m 0600 "$ca_private" "${staging}/ssh_ca_ed25519"
install -m 0644 "$ca_public" "${staging}/ssh_ca_ed25519.pub"

[ "$(sqlite3 "${staging}/boxhaven.sqlite" "PRAGMA quick_check;")" = "ok" ] \
  || fail "copied BoxHaven database failed SQLite quick_check"

derived_public="$(ssh-keygen -y -f "${staging}/ssh_ca_ed25519" 2>/dev/null)" \
  || fail "copied SSH CA private key is invalid"
derived_public="$(printf '%s\n' "$derived_public" | awk 'NF >= 2 { print $1 " " $2; exit }')"
stored_public="$(awk 'NF >= 2 { print $1 " " $2; exit }' "${staging}/ssh_ca_ed25519.pub")"
[ -n "$stored_public" ] && [ "$derived_public" = "$stored_public" ] \
  || fail "copied SSH CA private and public keys do not match"

if [ -d "${caddy_dir}" ]; then
  tar -C "${data_root}" -czf "${staging}/caddy-data.tar.gz" caddy
fi

tar -C "${staging}" -czf "${temporary_archive}" .
tar -tzf "${temporary_archive}" >/dev/null \
  || fail "created archive failed gzip/tar verification"
chmod 0600 "${temporary_archive}"
mv "${temporary_archive}" "${archive}"

find "${backup_root}" -maxdepth 1 -type f -name 'boxhaven-backend-*.tar.gz' -mtime "+${retention_days}" -delete

echo "${archive}"
