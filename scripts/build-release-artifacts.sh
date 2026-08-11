#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/build-release-artifacts.sh <vX.Y.Z> [output-directory]" >&2
  exit 2
}

fail() {
  echo "build release artifacts: $*" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
fi

tag="$1"
output_dir="${2:-dist}"

[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "tag must have the form vX.Y.Z: ${tag}"

case "$output_dir" in
  ""|/|.|..) fail "refusing unsafe output directory: ${output_dir:-<empty>}" ;;
esac
[ ! -L "$output_dir" ] || fail "refusing symlink output directory: ${output_dir}"
[ ! -e "$output_dir" ] || [ -d "$output_dir" ] \
  || fail "output path exists and is not a directory: ${output_dir}"

command -v go >/dev/null 2>&1 || fail "go is required"
command -v gzip >/dev/null 2>&1 || fail "gzip is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"
tar --sort=name --version >/dev/null 2>&1 \
  || fail "GNU tar with --sort support is required"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_date_epoch="${SOURCE_DATE_EPOCH:-$(git -C "$repo_root" show -s --format=%ct HEAD)}"
[[ "$source_date_epoch" =~ ^[0-9]+$ ]] \
  || fail "SOURCE_DATE_EPOCH must be an integer: ${source_date_epoch}"

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-release-build.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

targets=(
  darwin/amd64
  darwin/arm64
  linux/amd64
  linux/arm64
)

for target in "${targets[@]}"; do
  goos="${target%/*}"
  goarch="${target#*/}"
  asset="bh_${tag}_${goos}_${goarch}.tar.gz"
  stage="${temporary_dir}/stage-${goos}-${goarch}"
  mkdir "$stage"

  (
    cd "$repo_root"
    CGO_ENABLED=0 GOFLAGS='' GOOS="$goos" GOARCH="$goarch" \
      go build -buildvcs=false -trimpath \
        -ldflags "-buildid= -X main.Version=${tag}" \
        -o "${stage}/bh" ./cmd/bh
  )
  chmod 0755 "${stage}/bh"

  TZ=UTC tar \
    --sort=name \
    --format=ustar \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    --mode=0755 \
    --mtime="@${source_date_epoch}" \
    -cf - -C "$stage" bh \
    | gzip -n -9 > "${temporary_dir}/${asset}"
done

for target in "${targets[@]}"; do
  goos="${target%/*}"
  goarch="${target#*/}"
  asset="bh_${tag}_${goos}_${goarch}.tar.gz"
  printf '%s  %s\n' "$(sha256_file "${temporary_dir}/${asset}")" "$asset"
done > "${temporary_dir}/SHA256SUMS"

mkdir -p "$output_dir"
for target in "${targets[@]}"; do
  goos="${target%/*}"
  goarch="${target#*/}"
  asset="bh_${tag}_${goos}_${goarch}.tar.gz"
  rm -f "${output_dir}/${asset}"
  mv "${temporary_dir}/${asset}" "${output_dir}/${asset}"
done
rm -f "${output_dir}/SHA256SUMS"
mv "${temporary_dir}/SHA256SUMS" "${output_dir}/SHA256SUMS"

echo "built deterministic release artifacts in ${output_dir}"
