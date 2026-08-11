#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/verify-published-release.sh <vX.Y.Z>" >&2
  exit 2
}

fail() {
  echo "verify published release: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || usage
tag="$1"
[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "tag must have the form vX.Y.Z: ${tag}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-published-release.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT
artifact_dir="${temporary_dir}/dist"
mkdir "$artifact_dir"

api_url="https://api.github.com/repos/finbarr/boxhaven/releases/tags/${tag}"
curl -fsSL --retry 3 "$api_url" > "${temporary_dir}/release.json"
python3 - "$tag" "${temporary_dir}/release.json" <<'PY'
import json
import pathlib
import sys

tag = sys.argv[1]
release = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
expected = {
    "SHA256SUMS",
    f"bh_{tag}_darwin_amd64.tar.gz",
    f"bh_{tag}_darwin_arm64.tar.gz",
    f"bh_{tag}_linux_amd64.tar.gz",
    f"bh_{tag}_linux_arm64.tar.gz",
}
actual = {asset["name"] for asset in release.get("assets", [])}
if release.get("tag_name") != tag:
    raise SystemExit(f"release tag mismatch: {release.get('tag_name')!r}")
if release.get("draft") or release.get("prerelease"):
    raise SystemExit("release is still a draft or prerelease")
if actual != expected:
    raise SystemExit(f"release asset mismatch: expected {sorted(expected)}, got {sorted(actual)}")
PY

base_url="https://github.com/finbarr/boxhaven/releases/download/${tag}"
assets=(
  SHA256SUMS
  "bh_${tag}_darwin_amd64.tar.gz"
  "bh_${tag}_darwin_arm64.tar.gz"
  "bh_${tag}_linux_amd64.tar.gz"
  "bh_${tag}_linux_arm64.tar.gz"
)
for asset in "${assets[@]}"; do
  curl -fsSL --retry 3 "${base_url}/${asset}" -o "${artifact_dir}/${asset}"
done

"${repo_root}/scripts/verify-release-artifacts.sh" "$tag" "$artifact_dir"
"${repo_root}/scripts/render-homebrew-formula.sh" \
  "$tag" "${artifact_dir}/SHA256SUMS" "${temporary_dir}/boxhaven.rb"

install_dir="${temporary_dir}/install/bin"
BOXHAVEN_VERSION="$tag" BOXHAVEN_INSTALL_DIR="$install_dir" \
  sh "${repo_root}/install.sh"
version_output="$("${install_dir}/bh" version)"
case "$version_output" in
  "bh ${tag} ("*")") ;;
  *) fail "installed CLI reports an unexpected version: ${version_output}" ;;
esac

echo "verified published ${tag} assets, formula generation, and clean install.sh installation"
