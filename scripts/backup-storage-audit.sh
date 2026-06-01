#!/usr/bin/env bash
set -euo pipefail

targets="${BOXHAVEN_BACKUP_STORAGE_TARGETS:-}"
max_gib="${BOXHAVEN_BACKUP_STORAGE_MAX_GIB:-}"
max_files="${BOXHAVEN_BACKUP_STORAGE_MAX_FILES:-}"
ssh_command="${BOXHAVEN_BACKUP_STORAGE_SSH:-ssh -o BatchMode=yes}"

usage() {
  cat <<'EOF'
Usage:
  scripts/backup-storage-audit.sh

Audits backup directories by size and top-level file count. Targets may be local
paths or SSH paths. Use this for BoxHaven backend backups and adjacent
production services such as Fundy backup storage.

Env:
  BOXHAVEN_BACKUP_STORAGE_TARGETS=label=/path,fundy=root@host:/opt/fundy/backups
  BOXHAVEN_BACKUP_STORAGE_MAX_GIB=250
  BOXHAVEN_BACKUP_STORAGE_MAX_FILES=30
  BOXHAVEN_BACKUP_STORAGE_SSH="ssh -o BatchMode=yes"
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

trim() {
  sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

local_stats() {
  local path="$1"
  [ -d "$path" ] || {
    printf 'missing\t0\t0\n'
    return
  }
  printf 'ok\t%s\t%s\n' \
    "$(du -sk "$path" | awk '{print $1}')" \
    "$(find "$path" -maxdepth 1 -type f | wc -l | tr -d ' ')"
}

remote_stats() {
  local host="$1"
  local path="$2"
  # shellcheck disable=SC2086
  $ssh_command "$host" 'sh -s' -- "$path" <<'EOF'
path="$1"
if [ ! -d "$path" ]; then
  printf 'missing\t0\t0\n'
  exit 0
fi
printf 'ok\t%s\t%s\n' \
  "$(du -sk "$path" | awk '{print $1}')" \
  "$(find "$path" -maxdepth 1 -type f | wc -l | tr -d ' ')"
EOF
}

[ -n "$targets" ] || {
  printf 'set BOXHAVEN_BACKUP_STORAGE_TARGETS to at least one backup path\n' >&2
  exit 2
}

if [ -n "$max_gib" ] && ! [[ "$max_gib" =~ ^[0-9]+$ ]]; then
  printf 'BOXHAVEN_BACKUP_STORAGE_MAX_GIB must be an integer\n' >&2
  exit 2
fi
if [ -n "$max_files" ] && ! [[ "$max_files" =~ ^[0-9]+$ ]]; then
  printf 'BOXHAVEN_BACKUP_STORAGE_MAX_FILES must be an integer\n' >&2
  exit 2
fi

failures=0
max_kib=$((max_gib * 1024 * 1024))

while IFS= read -r target; do
  [ -n "$target" ] || continue
  label="$target"
  location="$target"
  case "$target" in
    *=*)
      label="${target%%=*}"
      location="${target#*=}"
      ;;
  esac

  if [[ "$location" == *:* && "$location" != /* ]]; then
    host="${location%%:*}"
    path="${location#*:}"
    stats="$(remote_stats "$host" "$path")"
  else
    path="$location"
    stats="$(local_stats "$path")"
  fi

  status="$(printf '%s' "$stats" | awk -F '\t' '{print $1}')"
  size_kib="$(printf '%s' "$stats" | awk -F '\t' '{print $2}')"
  file_count="$(printf '%s' "$stats" | awk -F '\t' '{print $3}')"
  size_gib="$(awk -v kib="$size_kib" 'BEGIN { printf "%.2f", kib / 1024 / 1024 }')"
  printf '%s: %s GiB, %s file(s) at %s\n' "$label" "$size_gib" "$file_count" "$location"

  if [ "$status" != "ok" ]; then
    fail "backup path is missing: ${label} (${location})"
    continue
  fi
  if [ -n "$max_gib" ] && [ "$size_kib" -gt "$max_kib" ]; then
    fail "backup path exceeds ${max_gib} GiB: ${label} is ${size_gib} GiB"
  fi
  if [ -n "$max_files" ] && [ "$file_count" -gt "$max_files" ]; then
    fail "backup path exceeds ${max_files} files: ${label} has ${file_count}"
  fi
done <<EOF_TARGETS
$(printf '%s' "$targets" | tr ',' '\n' | trim)
EOF_TARGETS

if [ "$failures" -gt 0 ]; then
  printf 'backup storage audit failed: %d failure(s)\n' "$failures" >&2
  exit 1
fi

printf 'backup storage audit passed\n'
