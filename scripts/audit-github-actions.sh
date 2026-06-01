#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workflow_dir="${BOXHAVEN_WORKFLOW_DIR:-${repo_root}/.github/workflows}"

usage() {
  cat <<'EOF'
Usage:
  scripts/audit-github-actions.sh

Checks BoxHaven GitHub workflows for the expected major versions of first-party
and release actions used by this repository.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

[ -d "$workflow_dir" ] || {
  printf 'workflow directory does not exist: %s\n' "$workflow_dir" >&2
  exit 2
}

failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

require_action() {
  local action="$1"
  local expected="$2"
  local matches
  matches="$(grep -RhoE "uses:[[:space:]]+${action}@[A-Za-z0-9._-]+" "$workflow_dir" || true)"
  if [ -z "$matches" ]; then
    fail "missing action ${action}"
    return
  fi
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    case "$line" in
      *"@${expected}") ;;
      *) fail "expected ${action}@${expected}, found ${line#uses: }" ;;
    esac
  done <<< "$matches"
}

require_action "actions/checkout" "v6"
require_action "actions/setup-go" "v6"
require_action "actions/setup-node" "v6"
require_action "actions/upload-artifact" "v7"
require_action "softprops/action-gh-release" "v3"

if [ "$failures" -gt 0 ]; then
  printf 'GitHub Actions audit failed: %d failure(s)\n' "$failures" >&2
  exit 1
fi

printf 'GitHub Actions audit passed\n'
