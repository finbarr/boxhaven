#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "release tooling test: $*" >&2
  exit 1
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-release-test.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

tag="v0.0.0"
first="${temporary_dir}/first"
second="${temporary_dir}/second"

"${repo_root}/scripts/build-release-artifacts.sh" "$tag" "$first"
"${repo_root}/scripts/verify-release-artifacts.sh" "$tag" "$first"
"${repo_root}/scripts/build-release-artifacts.sh" "$tag" "$second"
"${repo_root}/scripts/verify-release-artifacts.sh" "$tag" "$second"
diff -ru "$first" "$second" \
  || fail "two builds from the same commit produced different release artifacts"

formula="${temporary_dir}/Formula/boxhaven.rb"
"${repo_root}/scripts/render-homebrew-formula.sh" \
  "$tag" "${first}/SHA256SUMS" "$formula"
grep -Fq 'version "0.0.0"' "$formula" \
  || fail "rendered formula does not contain the test version"
grep -Fq 'license "AGPL-3.0-only"' "$formula" \
  || fail "rendered formula does not contain the repository license"

dry_run_output="${temporary_dir}/install-dry-run"
BOXHAVEN_VERSION="$tag" \
BOXHAVEN_INSTALL_DIR="${temporary_dir}/install/bin" \
  sh "${repo_root}/install.sh" --dry-run > "$dry_run_output"
grep -Fq "/releases/download/${tag}/bh_${tag}_" "$dry_run_output" \
  || fail "install.sh dry run does not use the release archive naming contract"
grep -Fq "/releases/download/${tag}/SHA256SUMS" "$dry_run_output" \
  || fail "install.sh dry run does not use the release checksum file"

echo "release tooling test passed"
