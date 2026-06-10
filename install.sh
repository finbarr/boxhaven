#!/bin/sh
# BoxHaven installer.
#
#   curl -fsSL https://raw.githubusercontent.com/finbarr/boxhaven/master/install.sh | sh
#
# Downloads the latest bh release for this platform, verifies it against the
# release's SHA256SUMS, and installs it to /usr/local/bin (sudo when needed)
# or ~/.local/bin as a fallback.
#
# Environment overrides:
#   BOXHAVEN_VERSION      install a specific release tag (e.g. v0.3.0 or 0.3.0)
#   BOXHAVEN_INSTALL_DIR  install into this directory instead of the defaults
#
# Flags:
#   --dry-run             print what would be downloaded and installed, then exit

set -eu

REPO="finbarr/boxhaven"
API_URL="https://api.github.com/repos/${REPO}"
DOWNLOAD_URL="https://github.com/${REPO}/releases/download"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

DRY_RUN=0
TMP_DIR=""

say() {
  printf '%b\n' "$*"
}

success() {
  say "${GREEN}✓${NC} $*"
}

info() {
  say "${CYAN}→${NC} $*"
}

warn() {
  say "${YELLOW}⚠${NC} $*"
}

error() {
  say "${RED}✗${NC} $*"
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}

detect_platform() {
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    *)
      error "Unsupported OS: $os"
      say "  BoxHaven ships binaries for macOS and Linux."
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="amd64" ;;
    arm64|aarch64) arch="arm64" ;;
    *)
      error "Unsupported architecture: $arch"
      say "  BoxHaven ships binaries for amd64 and arm64."
      exit 1
      ;;
  esac

  PLATFORM_OS="$os"
  PLATFORM_ARCH="$arch"
}

require_curl() {
  if ! command -v curl >/dev/null 2>&1; then
    error "curl is required to install BoxHaven"
    exit 1
  fi
}

sha256_tool() {
  if command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    echo "shasum -a 256"
  else
    echo ""
  fi
}

# Resolves VERSION (tag with leading "v") from BOXHAVEN_VERSION or the
# latest GitHub release. Sets VERSION, or empties it when no release exists.
resolve_version() {
  if [ -n "${BOXHAVEN_VERSION:-}" ]; then
    case "$BOXHAVEN_VERSION" in
      v*) VERSION="$BOXHAVEN_VERSION" ;;
      *)  VERSION="v$BOXHAVEN_VERSION" ;;
    esac
    return 0
  fi

  release_json="$(mktemp)"
  http_code="$(
    curl -sSL -o "$release_json" -w '%{http_code}' \
      "${API_URL}/releases/latest" 2>/dev/null || echo "000"
  )"

  if [ "$http_code" = "404" ]; then
    rm -f "$release_json"
    VERSION=""
    return 0
  fi

  if [ "$http_code" != "200" ]; then
    rm -f "$release_json"
    error "Could not query GitHub for the latest release (HTTP ${http_code})"
    say "  Check your network, or pin a version with ${CYAN}BOXHAVEN_VERSION=v0.x.y${NC}"
    exit 1
  fi

  VERSION="$(
    grep '"tag_name"' "$release_json" |
      sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true
  )"
  rm -f "$release_json"

  if [ -z "$VERSION" ]; then
    error "Could not parse the latest release tag from the GitHub API"
    exit 1
  fi
}

no_releases_yet() {
  warn "No releases published yet for ${BOLD}${REPO}${NC}"
  say ""
  say "  Once the first release is tagged, this script will install it."
  say "  Until then, build from source:"
  say "  ${CYAN}git clone https://github.com/${REPO}.git && cd boxhaven${NC}"
  say "  ${CYAN}go build -o bh ./cmd/bh${NC}"
  say ""
}

# Picks the install directory. Sets INSTALL_DIR and NEEDS_SUDO.
choose_install_dir() {
  NEEDS_SUDO=0

  if [ -n "${BOXHAVEN_INSTALL_DIR:-}" ]; then
    INSTALL_DIR="$BOXHAVEN_INSTALL_DIR"
    if [ -d "$INSTALL_DIR" ] && [ ! -w "$INSTALL_DIR" ]; then
      NEEDS_SUDO=1
    fi
    return 0
  fi

  INSTALL_DIR="/usr/local/bin"
  if [ -d "$INSTALL_DIR" ] && [ -w "$INSTALL_DIR" ]; then
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    NEEDS_SUDO=1
    return 0
  fi

  INSTALL_DIR="$HOME/.local/bin"
}

run_install() {
  src="$1"
  dest_dir="$2"

  if [ "$NEEDS_SUDO" = "1" ]; then
    info "Installing to ${BOLD}${dest_dir}${NC} (requires sudo)..."
    if sudo mkdir -p "$dest_dir" && sudo install -m 0755 "$src" "$dest_dir/bh"; then
      return 0
    fi
    warn "sudo install failed, falling back to ${BOLD}$HOME/.local/bin${NC}"
    dest_dir="$HOME/.local/bin"
    INSTALL_DIR="$dest_dir"
    NEEDS_SUDO=0
  fi

  mkdir -p "$dest_dir"
  install -m 0755 "$src" "$dest_dir/bh"
}

verify_checksum() {
  archive="$1"
  sums_file="$2"
  asset_name="$3"

  tool="$(sha256_tool)"
  if [ -z "$tool" ]; then
    warn "No sha256sum or shasum found, skipping checksum verification"
    return 0
  fi

  expected="$(grep " ${asset_name}\$" "$sums_file" | awk '{print $1}' || true)"
  if [ -z "$expected" ]; then
    error "SHA256SUMS has no entry for ${asset_name}"
    exit 1
  fi

  actual="$($tool "$archive" | awk '{print $1}')"
  if [ "$expected" != "$actual" ]; then
    error "Checksum mismatch for ${asset_name}"
    say "  expected: $expected"
    say "  actual:   $actual"
    exit 1
  fi

  success "Checksum verified"
}

post_install() {
  bindir="$1"

  if ! command -v bh >/dev/null 2>&1; then
    say ""
    warn "Make sure ${BOLD}$bindir${NC} is in your PATH"
    say ""
    say "  Add this to your shell config:"
    say "  ${CYAN}export PATH=\"$bindir:\$PATH\"${NC}"
  fi

  say ""
  say "  ${BOLD}Next steps:${NC}"
  say "  ${CYAN}bh login${NC}"
  say "  ${CYAN}bh create work${NC}"
  say "  ${CYAN}bh run work claude${NC}"
  say ""
  say "  ${YELLOW}Close the laptop. Your agents keep working.${NC}"
  say ""
}

main() {
  for arg in "$@"; do
    case "$arg" in
      --dry-run)
        DRY_RUN=1
        ;;
      *)
        error "Unknown option: $arg"
        say "  Usage: install.sh [--dry-run]"
        exit 1
        ;;
    esac
  done

  say ""
  say "${CYAN}${BOLD}  Installing BoxHaven...${NC}"
  say ""

  require_curl
  detect_platform
  resolve_version
  choose_install_dir

  if [ -z "$VERSION" ]; then
    no_releases_yet
    if [ "$DRY_RUN" = "1" ]; then
      info "Dry run: nothing to download yet"
      exit 0
    fi
    exit 1
  fi

  asset="bh_${VERSION}_${PLATFORM_OS}_${PLATFORM_ARCH}.tar.gz"
  asset_url="${DOWNLOAD_URL}/${VERSION}/${asset}"
  sums_url="${DOWNLOAD_URL}/${VERSION}/SHA256SUMS"

  if [ "$DRY_RUN" = "1" ]; then
    info "Dry run, nothing will be downloaded or installed"
    say ""
    say "  Version:     ${BOLD}${VERSION}${NC}"
    say "  Platform:    ${BOLD}${PLATFORM_OS}/${PLATFORM_ARCH}${NC}"
    say "  Archive:     ${CYAN}${asset_url}${NC}"
    say "  Checksums:   ${CYAN}${sums_url}${NC}"
    if [ "$NEEDS_SUDO" = "1" ]; then
      say "  Install to:  ${BOLD}${INSTALL_DIR}/bh${NC} (via sudo)"
    else
      say "  Install to:  ${BOLD}${INSTALL_DIR}/bh${NC}"
    fi
    say ""
    exit 0
  fi

  TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t boxhaven)"
  trap cleanup EXIT INT TERM

  info "Downloading bh ${VERSION} for ${PLATFORM_OS}/${PLATFORM_ARCH}..."
  if ! curl -fsSL "$asset_url" -o "$TMP_DIR/$asset"; then
    error "Could not download ${asset}"
    say "  Looked for: ${CYAN}${asset_url}${NC}"
    say "  Check ${CYAN}https://github.com/${REPO}/releases${NC} for available assets."
    exit 1
  fi

  info "Verifying checksum..."
  if ! curl -fsSL "$sums_url" -o "$TMP_DIR/SHA256SUMS"; then
    error "Could not download SHA256SUMS for ${VERSION}"
    exit 1
  fi
  verify_checksum "$TMP_DIR/$asset" "$TMP_DIR/SHA256SUMS" "$asset"

  tar -xzf "$TMP_DIR/$asset" -C "$TMP_DIR"
  if [ ! -f "$TMP_DIR/bh" ]; then
    error "Archive did not contain the bh binary"
    exit 1
  fi

  run_install "$TMP_DIR/bh" "$INSTALL_DIR"
  success "Installed bh ${VERSION} to ${BOLD}${INSTALL_DIR}/bh${NC}"
  post_install "$INSTALL_DIR"
}

main "$@"
