#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/verify-release-artifacts.sh <vX.Y.Z> [artifact-directory]" >&2
  exit 2
}

fail() {
  echo "verify release artifacts: $*" >&2
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
artifact_dir="${2:-dist}"

[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "tag must have the form vX.Y.Z: ${tag}"
[ -d "$artifact_dir" ] || fail "artifact directory does not exist: ${artifact_dir}"
command -v go >/dev/null 2>&1 || fail "go is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-release-verify.XXXXXX")"
trap 'rm -rf "$temporary_dir"' EXIT

expected_inventory="${temporary_dir}/expected-inventory"
actual_inventory="${temporary_dir}/actual-inventory"
expected_sums_inventory="${temporary_dir}/expected-sums-inventory"

cat > "$expected_inventory" <<EOF
SHA256SUMS
bh_${tag}_darwin_amd64.tar.gz
bh_${tag}_darwin_arm64.tar.gz
bh_${tag}_linux_amd64.tar.gz
bh_${tag}_linux_arm64.tar.gz
EOF

: > "$actual_inventory"
for path in "$artifact_dir"/* "$artifact_dir"/.[!.]* "$artifact_dir"/..?*; do
  [ -e "$path" ] || continue
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    fail "artifact directory contains a non-regular file: ${path}"
  fi
  basename "$path" >> "$actual_inventory"
done
LC_ALL=C sort -o "$actual_inventory" "$actual_inventory"
diff -u "$expected_inventory" "$actual_inventory" \
  || fail "artifact directory does not contain the exact release inventory"

tail -n +2 "$expected_inventory" > "$expected_sums_inventory"
awk '
  NF != 2 || length($1) != 64 || $1 !~ /^[0-9a-f]+$/ { exit 1 }
  { print $2 }
' "${artifact_dir}/SHA256SUMS" > "${temporary_dir}/actual-sums-inventory" \
  || fail "SHA256SUMS has an invalid line"
diff -u "$expected_sums_inventory" "${temporary_dir}/actual-sums-inventory" \
  || fail "SHA256SUMS does not name the four expected archives in order"

host_os="$(uname -s)"
case "$host_os" in
  Linux) host_os=linux ;;
  Darwin) host_os=darwin ;;
  *) host_os=unsupported ;;
esac
host_arch="$(uname -m)"
case "$host_arch" in
  x86_64|amd64) host_arch=amd64 ;;
  arm64|aarch64) host_arch=arm64 ;;
  *) host_arch=unsupported ;;
esac

while read -r expected asset extra; do
  [ -z "${extra:-}" ] || fail "SHA256SUMS has extra fields for ${asset}"
  archive="${artifact_dir}/${asset}"
  actual="$(sha256_file "$archive")"
  [ "$expected" = "$actual" ] \
    || fail "checksum mismatch for ${asset}: expected ${expected}, got ${actual}"

  archive_inventory="$(tar -tzf "$archive")"
  [ "$archive_inventory" = "bh" ] \
    || fail "${asset} must contain exactly one top-level file named bh"

  platform="${asset#bh_"${tag}"_}"
  platform="${platform%.tar.gz}"
  goarch="${platform##*_}"
  goos="${platform%_*}"
  extracted="${temporary_dir}/${goos}-${goarch}"
  mkdir "$extracted"
  tar -xzf "$archive" -C "$extracted"
  if [ ! -f "${extracted}/bh" ] || [ -L "${extracted}/bh" ] || [ ! -x "${extracted}/bh" ]; then
    fail "${asset} does not contain an executable regular bh binary"
  fi

  build_info="$(go version -m "${extracted}/bh")"
  grep -Fq "GOOS=${goos}" <<< "$build_info" \
    || fail "${asset} binary build metadata does not report GOOS=${goos}"
  grep -Fq "GOARCH=${goarch}" <<< "$build_info" \
    || fail "${asset} binary build metadata does not report GOARCH=${goarch}"
  LC_ALL=C grep -aFq "$tag" "${extracted}/bh" \
    || fail "${asset} binary does not contain embedded version ${tag}"

  if [ "$goos" = "$host_os" ] && [ "$goarch" = "$host_arch" ]; then
    version_output="$("${extracted}/bh" version)"
    [ "$version_output" = "bh ${tag} (${goos}/${goarch})" ] \
      || fail "${asset} reports an unexpected version: ${version_output}"
  fi
done < "${artifact_dir}/SHA256SUMS"

echo "verified ${tag} release artifact names, checksums, contents, targets, and version"
