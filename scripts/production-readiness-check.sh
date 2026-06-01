#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${BOXHAVEN_READINESS_VERSION:-readiness-local}"
keep_dist="${BOXHAVEN_READINESS_KEEP_DIST:-0}"
export HOME="${HOME:-/root}"

usage() {
  cat <<'EOF'
Usage:
  scripts/production-readiness-check.sh

Runs local production-readiness checks that do not require live cloud
credentials. This intentionally does not replace the remote lifecycle smoke or
DigitalOcean audit; run those against production or prod-equivalent
infrastructure before release.

Env:
  BOXHAVEN_READINESS_VERSION=readiness-local
  BOXHAVEN_READINESS_KEEP_DIST=0
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

run() {
  printf '==> %s\n' "$*"
  "$@"
}

cleanup() {
  if [ "$keep_dist" != "1" ]; then
    rm -f \
      "${repo_root}/dist/boxhaven-${version}-"* \
      "${repo_root}/dist/checksums-${version}.txt"
    rmdir "${repo_root}/dist" 2>/dev/null || true
  fi
}
trap cleanup EXIT

cd "$repo_root"

require_command bash
require_command go
require_command npm
require_command python3
require_command sha256sum

run bash -n scripts/*.sh deploy/digitalocean/*.sh
run scripts/audit-github-actions.sh
run scripts/production-fixture-test.sh
run scripts/validate-caddy-config.sh
run make clean
run make build
run make test
run make lint
run npm --prefix backend run build
run ./bh version
run ./bh help
run ./bh config
run env VERSION="$version" make dist
run bash -c "cd dist && sha256sum -c checksums-${version}.txt"
run scripts/install-bh.sh --help
run python3 .github/scripts/extract-release-notes.py "$version" CHANGELOG.md
run python3 .github/scripts/extract-release-notes.py v999.999.999 CHANGELOG.md

printf 'local production-readiness checks passed\n'
