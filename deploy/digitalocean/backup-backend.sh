#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
backup_root="${BOXHAVEN_BACKUP_ROOT:-/opt/boxhaven/backups}"
data_root="${BOXHAVEN_DATA_ROOT:-/opt/boxhaven/data}"
retention_days="${BOXHAVEN_BACKUP_RETENTION_DAYS:-14}"
verify_after_create="${BOXHAVEN_BACKUP_VERIFY_AFTER_CREATE:-1}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
archive_base="${backup_root}/boxhaven-backend-${timestamp}"
archive="${archive_base}.tar.gz"

mkdir -p "${backup_root}"
if [ -e "$archive" ]; then
  archive_suffix=1
  while [ -e "${archive_base}-${archive_suffix}.tar.gz" ]; do
    archive_suffix=$((archive_suffix + 1))
  done
  archive="${archive_base}-${archive_suffix}.tar.gz"
fi

tmpdir="$(mktemp -d "${backup_root}/.tmp-boxhaven-backend.XXXXXX")"

cleanup() {
  rm -rf "${tmpdir}"
}
trap cleanup EXIT

backend_dir="${data_root}/backend"
caddy_dir="${data_root}/caddy"

if [ -f "${backend_dir}/auth.sqlite" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "${backend_dir}/auth.sqlite" ".backup '${tmpdir}/auth.sqlite'"
  else
    cp -a "${backend_dir}/auth.sqlite" "${tmpdir}/auth.sqlite"
  fi
fi

for file in backend.json auth.sqlite-wal auth.sqlite-shm ssh_ca_ed25519 ssh_ca_ed25519.pub; do
  if [ -f "${backend_dir}/${file}" ]; then
    cp -a "${backend_dir}/${file}" "${tmpdir}/${file}"
  fi
done

if [ -d "${caddy_dir}" ]; then
  tar -C "${data_root}" -czf "${tmpdir}/caddy-data.tar.gz" caddy
fi

tar -C "${tmpdir}" -czf "${archive}" .
chmod 0600 "${archive}"

if [ "$verify_after_create" = "1" ]; then
  verify_command="${BOXHAVEN_BACKUP_VERIFY_COMMAND:-}"
  if [ -z "$verify_command" ]; then
    if [ -x "${script_dir}/../../scripts/verify-backend-backup-restore.sh" ]; then
      verify_command="${script_dir}/../../scripts/verify-backend-backup-restore.sh"
    else
      verify_command="boxhaven-verify-backend-backup"
    fi
  fi
  if ! "$verify_command" "$archive" >/dev/null; then
    rm -f "$archive"
    exit 1
  fi
fi

find "${backup_root}" -maxdepth 1 -type f -name 'boxhaven-backend-*.tar.gz' -mtime "+${retention_days}" -delete

echo "${archive}"
