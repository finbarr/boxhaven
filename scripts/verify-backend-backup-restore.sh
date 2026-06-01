#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
if [ -z "$archive" ]; then
  printf 'usage: %s /path/to/boxhaven-backend-YYYYmmddTHHMMSSZ.tar.gz\n' "$0" >&2
  exit 2
fi
if [ ! -f "$archive" ]; then
  printf 'backup archive does not exist: %s\n' "$archive" >&2
  exit 2
fi

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-restore.XXXXXX")"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

tar -C "$tmpdir" -xzf "$archive"

require_file() {
  if [ ! -f "$tmpdir/$1" ]; then
    printf 'backup is missing required file: %s\n' "$1" >&2
    exit 1
  fi
}

require_file backend.json
require_file auth.sqlite
require_file ssh_ca_ed25519
require_file ssh_ca_ed25519.pub

node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$tmpdir/backend.json"

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$tmpdir/auth.sqlite" 'PRAGMA integrity_check;' | grep -Fx 'ok' >/dev/null
fi

chmod 0600 "$tmpdir/ssh_ca_ed25519"
ssh-keygen -y -f "$tmpdir/ssh_ca_ed25519" > "$tmpdir/ssh_ca_ed25519.derived.pub"
cmp -s "$tmpdir/ssh_ca_ed25519.pub" "$tmpdir/ssh_ca_ed25519.derived.pub"

if [ -f "$tmpdir/caddy-data.tar.gz" ]; then
  tar -tzf "$tmpdir/caddy-data.tar.gz" >/dev/null
fi

printf 'backup restore verification passed: %s\n' "$archive"
