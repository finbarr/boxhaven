#!/usr/bin/env bash
set -euo pipefail

repo="${BOXHAVEN_INSTALL_REPO:-finbarr/boxhaven}"
version="${BOXHAVEN_INSTALL_VERSION:-latest}"
bindir="${BOXHAVEN_INSTALL_DIR:-${HOME:-/root}/.local/bin}"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/boxhaven-install.XXXXXX")"

cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage:
  scripts/install-bh.sh

Installs the bh CLI from a GitHub release archive.

Env:
  BOXHAVEN_INSTALL_VERSION=v0.1.0   # default: latest
  BOXHAVEN_INSTALL_REPO=finbarr/boxhaven
  BOXHAVEN_INSTALL_DIR=$HOME/.local/bin
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

detect_os() {
  case "$(uname -s)" in
    Linux) printf 'linux' ;;
    Darwin) printf 'darwin' ;;
    *) printf 'unsupported OS: %s\n' "$(uname -s)" >&2; exit 2 ;;
  esac
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) printf 'amd64' ;;
    arm64|aarch64) printf 'arm64' ;;
    *) printf 'unsupported architecture: %s\n' "$(uname -m)" >&2; exit 2 ;;
  esac
}

require_command curl
require_command tar
require_command sha256sum

os="$(detect_os)"
arch="$(detect_arch)"

if [ "$version" = "latest" ]; then
  version="$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
fi
[ -n "$version" ] || {
  printf 'could not determine release version\n' >&2
  exit 1
}

base_url="https://github.com/${repo}/releases/download/${version}"
archive="boxhaven-${version}-${os}-${arch}.tar.gz"
checksums="checksums-${version}.txt"

curl -fsSL "${base_url}/${archive}" -o "${tmpdir}/${archive}"
curl -fsSL "${base_url}/${checksums}" -o "${tmpdir}/${checksums}"

(cd "$tmpdir" && grep " ${archive}$" "$checksums" | sha256sum -c -)
tar -C "$tmpdir" -xzf "${tmpdir}/${archive}" bh

mkdir -p "$bindir"
install -m 0755 "${tmpdir}/bh" "${bindir}/bh"
"${bindir}/bh" version
printf 'installed bh to %s/bh\n' "$bindir"
