#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist_dir="${BOXHAVEN_DIST_DIR:-${repo_root}/dist}"
version="${VERSION:-}"
export HOME="${HOME:-/root}"

usage() {
  cat <<'EOF'
Usage:
  scripts/build-release.sh

Builds versioned bh CLI release archives for common platforms under dist/.

Env:
  VERSION=v0.1.0
  BOXHAVEN_DIST_DIR=dist
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

require_command go
require_command tar
require_command sha256sum
require_command git

if [ -z "$version" ]; then
  version="$(git -C "$repo_root" describe --tags --always --dirty 2>/dev/null || printf 'dev')"
fi

mkdir -p "$dist_dir"
rm -f "${dist_dir}/boxhaven-${version}-"* "${dist_dir}/checksums-${version}.txt"

platforms=(
  "linux amd64"
  "linux arm64"
  "darwin amd64"
  "darwin arm64"
)

for platform in "${platforms[@]}"; do
  set -- $platform
  goos="$1"
  goarch="$2"
  name="boxhaven-${version}-${goos}-${goarch}"
  workdir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-release.XXXXXX")"
  cleanup() {
    rm -rf "$workdir"
  }
  trap cleanup RETURN
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build \
    -ldflags "-X main.Version=${version}" \
    -o "${workdir}/bh" \
    "${repo_root}/cmd/bh"
  cp "${repo_root}/README.md" "${workdir}/README.md"
  cp "${repo_root}/LICENSE" "${workdir}/LICENSE"
  tar -C "$workdir" -czf "${dist_dir}/${name}.tar.gz" bh README.md LICENSE
  sha256sum "${dist_dir}/${name}.tar.gz" >> "${dist_dir}/checksums-${version}.txt"
  rm -rf "$workdir"
  trap - RETURN
  printf 'built %s\n' "${dist_dir}/${name}.tar.gz"
done

printf 'wrote %s\n' "${dist_dir}/checksums-${version}.txt"
