#!/usr/bin/env bash
set -euo pipefail

app_host="${BOXHAVEN_DNS_APP_HOST:-${BOXHAVEN_APP_HOST:-app.boxhaven.dev}}"
api_host="${BOXHAVEN_DNS_API_HOST:-${BOXHAVEN_API_HOST:-api.boxhaven.dev}}"
preview_base_domain="${BOXHAVEN_DNS_PREVIEW_BASE_DOMAIN:-${BOXHAVEN_PREVIEW_BASE_DOMAIN:-at.boxhaven.dev}}"
preview_test_host="${BOXHAVEN_DNS_PREVIEW_TEST_HOST:-sample.${preview_base_domain}}"
expected_ip="${BOXHAVEN_DNS_EXPECTED_IP:-}"
fixture_path="${BOXHAVEN_DNS_FIXTURE:-}"

usage() {
  cat <<'EOF'
Usage:
  scripts/smoke-production-dns.sh

Checks production DNS for the app host, API host, and a preview wildcard sample
host. If BOXHAVEN_DNS_EXPECTED_IP is set, each host must resolve to that IPv4.

Env:
  BOXHAVEN_DNS_APP_HOST=app.boxhaven.dev
  BOXHAVEN_DNS_API_HOST=api.boxhaven.dev
  BOXHAVEN_DNS_PREVIEW_BASE_DOMAIN=at.boxhaven.dev
  BOXHAVEN_DNS_PREVIEW_TEST_HOST=sample.at.boxhaven.dev
  BOXHAVEN_DNS_EXPECTED_IP=<control-plane-ip>
  BOXHAVEN_DNS_FIXTURE=/path/to/hosts.txt # local tests: lines are "host ip"
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

resolve_fixture() {
  local host="$1"
  awk -v host="$host" '$1 == host { print $2 }' "$fixture_path" | sort -u
}

resolve_live() {
  local host="$1"
  if command -v getent >/dev/null 2>&1; then
    getent ahostsv4 "$host" | awk '{print $1}' | sort -u
    return
  fi
  python3 - "$host" <<'PY'
import socket
import sys

host = sys.argv[1]
ips = {
    item[4][0]
    for item in socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)
}
for ip in sorted(ips):
    print(ip)
PY
}

resolve_host() {
  local host="$1"
  if [ -n "$fixture_path" ]; then
    [ -f "$fixture_path" ] || {
      printf 'DNS fixture does not exist: %s\n' "$fixture_path" >&2
      exit 2
    }
    resolve_fixture "$host"
  else
    resolve_live "$host"
  fi
}

check_host() {
  local label="$1"
  local host="$2"
  local ips
  ips="$(resolve_host "$host")"
  if [ -z "$ips" ]; then
    printf 'DNS lookup returned no IPv4 records for %s (%s)\n' "$label" "$host" >&2
    exit 1
  fi
  printf '%s %s -> %s\n' "$label" "$host" "$(printf '%s' "$ips" | paste -sd, -)"
  if [ -n "$expected_ip" ] && ! printf '%s\n' "$ips" | grep -Fx "$expected_ip" >/dev/null; then
    printf 'expected %s (%s) to resolve to %s, got %s\n' "$label" "$host" "$expected_ip" "$(printf '%s' "$ips" | paste -sd, -)" >&2
    exit 1
  fi
}

require_command awk
if [ -z "$fixture_path" ]; then
  command -v getent >/dev/null 2>&1 || require_command python3
fi

check_host app "$app_host"
check_host api "$api_host"
check_host preview "$preview_test_host"

printf 'production DNS smoke passed\n'
