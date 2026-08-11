#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/check-release-metadata.sh <vX.Y.Z> [release-notes-output]" >&2
  exit 2
}

fail() {
  echo "check release metadata: $*" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
fi

tag="$1"
notes_output="${2:-release-notes.md}"
[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "tag must have the form vX.Y.Z: ${tag}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${tag#v}"
heading_pattern="^## v?${version//./\\.} - [0-9]{4}-[0-9]{2}-[0-9]{2}$"

python3 "${repo_root}/.github/scripts/extract-release-notes.py" \
  "$tag" "${repo_root}/CHANGELOG.md" > "$notes_output"

heading="$(head -n 1 "$notes_output")"
[[ "$heading" =~ $heading_pattern ]] \
  || fail "${tag} changelog heading must have a final YYYY-MM-DD date, got: ${heading}"
[ "$(wc -l < "$notes_output")" -gt 2 ] \
  || fail "${tag} release notes are empty"
! grep -Fq 'TBD' "$notes_output" \
  || fail "${tag} release notes still contain TBD"

if git -C "$repo_root" show-ref --verify --quiet "refs/tags/${tag}"; then
  tag_commit="$(git -C "$repo_root" rev-parse "${tag}^{commit}")"
  head_commit="$(git -C "$repo_root" rev-parse HEAD)"
  [ "$tag_commit" = "$head_commit" ] \
    || fail "${tag} points to ${tag_commit}, but the workflow checked out ${head_commit}"
fi

echo "verified ${tag} changelog metadata"
