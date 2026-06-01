#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
caddyfile="${BOXHAVEN_CADDYFILE:-${repo_root}/deploy/digitalocean/Caddyfile}"
caddy_image="${BOXHAVEN_CADDY_VALIDATE_IMAGE:-caddy:2}"

usage() {
  cat <<'EOF'
Usage:
  scripts/validate-caddy-config.sh

Validates the production Caddyfile with production-shaped placeholder values.
Uses a local caddy binary when available, otherwise falls back to Docker.

Env:
  BOXHAVEN_CADDYFILE=deploy/digitalocean/Caddyfile
  BOXHAVEN_CADDY_VALIDATE_IMAGE=caddy:2
  ACME_EMAIL=ops@example.com
  BOXHAVEN_APP_HOST=app.boxhaven.dev
  BOXHAVEN_API_HOST=api.boxhaven.dev
  BOXHAVEN_PREVIEW_BASE_DOMAIN=preview.boxhaven.dev
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

[ -f "$caddyfile" ] || {
  printf 'Caddyfile does not exist: %s\n' "$caddyfile" >&2
  exit 2
}

export ACME_EMAIL="${ACME_EMAIL:-ops@example.com}"
export BOXHAVEN_APP_HOST="${BOXHAVEN_APP_HOST:-app.boxhaven.dev}"
export BOXHAVEN_API_HOST="${BOXHAVEN_API_HOST:-api.boxhaven.dev}"
export BOXHAVEN_PREVIEW_BASE_DOMAIN="${BOXHAVEN_PREVIEW_BASE_DOMAIN:-preview.boxhaven.dev}"

if command -v caddy >/dev/null 2>&1; then
  caddy validate --config "$caddyfile" --adapter caddyfile
  exit 0
fi

if command -v docker >/dev/null 2>&1; then
  docker run --rm \
    -e ACME_EMAIL \
    -e BOXHAVEN_APP_HOST \
    -e BOXHAVEN_API_HOST \
    -e BOXHAVEN_PREVIEW_BASE_DOMAIN \
    -v "${caddyfile}:/etc/caddy/Caddyfile:ro" \
    "$caddy_image" \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  exit 0
fi

printf 'missing caddy or docker for Caddyfile validation\n' >&2
exit 2
