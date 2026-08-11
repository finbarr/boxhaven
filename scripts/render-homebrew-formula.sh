#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/render-homebrew-formula.sh <vX.Y.Z> <SHA256SUMS> <output-formula>" >&2
  exit 2
}

fail() {
  echo "render Homebrew formula: $*" >&2
  exit 1
}

[ "$#" -eq 3 ] || usage

tag="$1"
sums_file="$2"
output_formula="$3"

[[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "tag must have the form vX.Y.Z: ${tag}"
[ -f "$sums_file" ] || fail "checksum file does not exist: ${sums_file}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template="${repo_root}/packaging/homebrew/boxhaven.rb"
[ -f "$template" ] || fail "formula template does not exist: ${template}"

expected_assets="$(cat <<EOF
bh_${tag}_darwin_amd64.tar.gz
bh_${tag}_darwin_arm64.tar.gz
bh_${tag}_linux_amd64.tar.gz
bh_${tag}_linux_arm64.tar.gz
EOF
)"
actual_assets="$(awk '
  NF != 2 || length($1) != 64 || $1 !~ /^[0-9a-f]+$/ { exit 1 }
  { print $2 }
' "$sums_file")" || fail "SHA256SUMS has an invalid line"
[ "$actual_assets" = "$expected_assets" ] \
  || fail "SHA256SUMS does not contain the four expected archives in order"

sum_for() {
  asset="$1"
  awk -v asset="$asset" '$2 == asset { print $1 }' "$sums_file"
}

darwin_amd64="$(sum_for "bh_${tag}_darwin_amd64.tar.gz")"
darwin_arm64="$(sum_for "bh_${tag}_darwin_arm64.tar.gz")"
linux_amd64="$(sum_for "bh_${tag}_linux_amd64.tar.gz")"
linux_arm64="$(sum_for "bh_${tag}_linux_arm64.tar.gz")"
version="${tag#v}"

output_parent="$(dirname "$output_formula")"
mkdir -p "$output_parent"
temporary_formula="$(mktemp "${output_formula}.tmp.XXXXXX")"
trap 'rm -f "$temporary_formula"' EXIT

sed \
  -e "s/__VERSION__/${version}/g" \
  -e "s/__SHA256_DARWIN_AMD64__/${darwin_amd64}/g" \
  -e "s/__SHA256_DARWIN_ARM64__/${darwin_arm64}/g" \
  -e "s/__SHA256_LINUX_AMD64__/${linux_amd64}/g" \
  -e "s/__SHA256_LINUX_ARM64__/${linux_arm64}/g" \
  "$template" > "$temporary_formula"

! grep -Eq '__[A-Z0-9_]+__' "$temporary_formula" \
  || fail "formula still contains an unsubstituted placeholder"
grep -Fq "version \"${version}\"" "$temporary_formula" \
  || fail "formula does not contain version ${version}"
for checksum in "$darwin_amd64" "$darwin_arm64" "$linux_amd64" "$linux_arm64"; do
  [ "$(grep -Fc "sha256 \"${checksum}\"" "$temporary_formula")" -eq 1 ] \
    || fail "formula does not contain checksum ${checksum} exactly once"
done
if command -v ruby >/dev/null 2>&1; then
  ruby -c "$temporary_formula" >/dev/null
fi

mv "$temporary_formula" "$output_formula"
trap - EXIT
echo "rendered ${tag} Homebrew formula at ${output_formula}"
