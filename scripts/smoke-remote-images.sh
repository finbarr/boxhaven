#!/usr/bin/env bash
# Run on a Linux Docker host with built backend/dist and a valid TLS certificate.
set -euo pipefail
umask 077
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${BOXHAVEN_IMAGE_SMOKE_ENV_FILE:?Set a provider configuration env file}"
: "${BOXHAVEN_IMAGE_SMOKE_HOSTNAME:?Set the hostname pointing at this host}"
: "${BOXHAVEN_IMAGE_SMOKE_TLS_CERT:?Set the PEM certificate path}"
: "${BOXHAVEN_IMAGE_SMOKE_TLS_KEY:?Set the PEM private key path}"
runtime_image="${BOXHAVEN_IMAGE_SMOKE_RUNTIME_IMAGE:-boxhaven/backend:local}"
tls_port="${BOXHAVEN_IMAGE_SMOKE_TLS_PORT:-8443}"
api_port="${BOXHAVEN_IMAGE_SMOKE_PORT:-18789}"
[[ "$tls_port" =~ ^[0-9]+$ && "$api_port" =~ ^[0-9]+$ ]]
[[ "$BOXHAVEN_IMAGE_SMOKE_HOSTNAME" =~ ^[a-zA-Z0-9.-]+$ ]]
test -f "$repo_dir/backend/dist/server.js"
test -f "$repo_dir/deploy/digitalocean/clean-remote-image.sh"
test -f "$BOXHAVEN_IMAGE_SMOKE_TLS_CERT"
test -f "$BOXHAVEN_IMAGE_SMOKE_TLS_KEY"
test -z "$(ss -H -ltn "sport = :$tls_port")"
test -z "$(ss -H -ltn "sport = :$api_port")"
run_name="boxhaven-image-smoke-$(date +%s)-$$"
out_dir="$repo_dir/backend/.artifacts/$run_name"
mkdir -p "$out_dir/results"
runtime_dir="$(docker image inspect "$runtime_image" --format '{{.Config.WorkingDir}}')"
test -n "$runtime_dir"
runtime_repo_dir="$(dirname "$runtime_dir")"

cleanup() {
  # SIGTERM lets the harness delete its own cloud resources before stopping.
  docker stop --time 1800 "$run_name" >/dev/null 2>&1 || true
  docker rm "$run_name" >/dev/null 2>&1 || true
  docker rm -f "$run_name-proxy" >/dev/null 2>&1 || true
  rm -f "$out_dir/provider.env"
  echo "Image smoke artifacts: $out_dir/results"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Pass only provider configuration. Never expose production auth, billing,
# email credentials, SQLite, or SSH CA keys to this temporary backend.
python3 - "$BOXHAVEN_IMAGE_SMOKE_ENV_FILE" "$out_dir/provider.env" <<'PY'
import shlex, sys
allowed = {
    'DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_TOKEN', 'DO_API_TOKEN',
    'DIGITALOCEAN_REGION', 'DIGITALOCEAN_SIZE', 'DIGITALOCEAN_VPC_UUID',
    'BOXHAVEN_REMOTE_IMAGE', 'BOXHAVEN_REMOTE_IMAGE_DIGITALOCEAN',
}
with open(sys.argv[2], 'x') as output:
    for line in open(sys.argv[1]):
        key, separator, value = line.strip().removeprefix('export ').partition('=')
        if separator and key.strip() in allowed:
            parsed = shlex.split(value, comments=True)
            if parsed:
                output.write(f'{key.strip()}={" ".join(parsed)}\n')
PY
cat > "$out_dir/Caddyfile" <<EOF
{
  admin off
  auto_https disable_redirects
}
https://${BOXHAVEN_IMAGE_SMOKE_HOSTNAME}:${tls_port} {
  tls /smoke/tls.crt /smoke/tls.key
  handle /v1/agent/* {
    reverse_proxy 127.0.0.1:${api_port}
  }
  handle {
    respond 404
  }
}
EOF
docker run -d --name "$run_name-proxy" --network host \
  -v "$out_dir/Caddyfile:/etc/caddy/Caddyfile:ro" \
  -v "$BOXHAVEN_IMAGE_SMOKE_TLS_CERT:/smoke/tls.crt:ro" \
  -v "$BOXHAVEN_IMAGE_SMOKE_TLS_KEY:/smoke/tls.key:ro" \
  caddy:2-alpine >/dev/null
# Production images may use different numeric UIDs. Run as that image's user.
runtime_uid="$(docker run --rm --entrypoint id "$runtime_image" -u)"
runtime_gid="$(docker run --rm --entrypoint id "$runtime_image" -g)"
chown "$runtime_uid:$runtime_gid" "$out_dir/results"
docker run --name "$run_name" --network host --env-file "$out_dir/provider.env" \
  -e "BOXHAVEN_IMAGE_SMOKE_PUBLIC_URL=https://${BOXHAVEN_IMAGE_SMOKE_HOSTNAME}:${tls_port}" \
  -e "BOXHAVEN_IMAGE_SMOKE_PORT=$api_port" -e BOXHAVEN_IMAGE_SMOKE_OUT=/smoke-results \
  -v "$repo_dir/backend/dist:$runtime_dir/dist:ro" \
  -v "$repo_dir/backend/scripts/remote-images-smoke.mjs:$runtime_dir/scripts/remote-images-smoke.mjs:ro" \
  -v "$repo_dir/deploy/digitalocean/clean-remote-image.sh:$runtime_repo_dir/deploy/digitalocean/clean-remote-image.sh:ro" \
  -v "$out_dir/results:/smoke-results" --entrypoint node \
  "$runtime_image" scripts/remote-images-smoke.mjs 2>&1 | tee "$out_dir/smoke.log"
