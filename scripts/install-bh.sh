#!/usr/bin/env bash
set -euo pipefail

repo="${BOXHAVEN_INSTALL_REPO:-finbarr/boxhaven}"
version="${BOXHAVEN_INSTALL_VERSION:-latest}"
bindir="${BOXHAVEN_INSTALL_DIR:-${HOME:-/root}/.local/bin}"
base_url="${BOXHAVEN_INSTALL_BASE_URL:-}"
checksum_tool="${BOXHAVEN_INSTALL_CHECKSUM_TOOL:-auto}"
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
  BOXHAVEN_INSTALL_BASE_URL=https://github.com/finbarr/boxhaven/releases/download/v0.1.0
  BOXHAVEN_INSTALL_CHECKSUM_TOOL=auto # auto, sha256sum, or shasum
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

verify_checksum() {
  local checksums="$1"
  local archive="$2"
  local line
  line="$(grep " ${archive}$" "$checksums")" || {
    printf 'checksum file does not contain %s\n' "$archive" >&2
    exit 1
  }
  case "$checksum_tool" in
    auto)
      if command -v sha256sum >/dev/null 2>&1; then
        printf '%s\n' "$line" | sha256sum -c -
      elif command -v shasum >/dev/null 2>&1; then
        printf '%s\n' "$line" | shasum -a 256 -c -
      else
        printf 'missing sha256sum or shasum for checksum verification\n' >&2
        exit 2
      fi
      ;;
    sha256sum)
      require_command sha256sum
      printf '%s\n' "$line" | sha256sum -c -
      ;;
    shasum)
      require_command shasum
      printf '%s\n' "$line" | shasum -a 256 -c -
      ;;
    *)
      printf 'unsupported BOXHAVEN_INSTALL_CHECKSUM_TOOL: %s\n' "$checksum_tool" >&2
      exit 2
      ;;
  esac
}

os="${BOXHAVEN_INSTALL_OS:-$(detect_os)}"
arch="${BOXHAVEN_INSTALL_ARCH:-$(detect_arch)}"

if [ "$version" = "latest" ]; then
  version="$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)"
fi
[ -n "$version" ] || {
  printf 'could not determine release version\n' >&2
  exit 1
}

base_url="${base_url:-https://github.com/${repo}/releases/download/${version}}"
archive="boxhaven-${version}-${os}-${arch}.tar.gz"
checksums="checksums-${version}.txt"

curl -fsSL "${base_url}/${archive}" -o "${tmpdir}/${archive}"
curl -fsSL "${base_url}/${checksums}" -o "${tmpdir}/${checksums}"

(cd "$tmpdir" && verify_checksum "$checksums" "$archive")
tar -C "$tmpdir" -xzf "${tmpdir}/${archive}" bh

mkdir -p "$bindir"
install -m 0755 "${tmpdir}/bh" "${bindir}/bh"
"${bindir}/bh" version
printf 'installed bh to %s/bh\n' "$bindir"
