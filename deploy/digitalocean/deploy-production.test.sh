#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
deploy_script="${repo_root}/deploy/digitalocean/deploy-production.sh"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *)
      echo "expected output to contain: $2" >&2
      echo "actual output: $1" >&2
      exit 1
      ;;
  esac
}

mkdir -p "${temp_dir}/bin"
docker_log="${temp_dir}/docker.log"

cat > "${temp_dir}/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${DOCKER_LOG}"
EOF
cat > "${temp_dir}/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "${temp_dir}/bin/ssh" <<'EOF'
#!/usr/bin/env bash
[ "$1" = "-A" ]
shift 2
[ "$#" -eq 1 ]
exec bash -c "$1"
EOF
chmod +x "${temp_dir}/bin/docker" "${temp_dir}/bin/curl" "${temp_dir}/bin/ssh"

public_env="${temp_dir}/public.env"
protected_env="${temp_dir}/protected.env"
overlay_env="${temp_dir}/overlay.env"
overlay_file="${temp_dir}/compose.overlay.yml"
printf 'BOXHAVEN_COMMERCIAL_POLICY_URL=\n' > "$public_env"
printf 'BOXHAVEN_COMMERCIAL_POLICY_URL="http://hosted:8790"\n' > "$protected_env"
printf 'POLICY_IMAGE=example/policy:test\n' > "$overlay_env"
printf 'services:\n  policy:\n    image: ${POLICY_IMAGE}\n' > "$overlay_file"

run_deploy() {
  env \
    -u BOXHAVEN_COMMERCIAL_POLICY_URL \
    -u BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_FILE \
    -u BOXHAVEN_PRODUCTION_COMPOSE_OVERLAY_ENV_FILE \
    PATH="${temp_dir}/bin:${PATH}" \
    DOCKER_LOG="$docker_log" \
    BOXHAVEN_PRODUCTION_ENV_FILE="$1" \
    BOXHAVEN_PRODUCTION_API_HEALTH_URL=http://api.test/healthz \
    BOXHAVEN_PRODUCTION_APP_HEALTH_URL=http://app.test/healthz \
    BOXHAVEN_PRODUCTION_DOCS_HEALTH_URL=http://docs.test/ \
    "$deploy_script" "${@:2}"
}

: > "$docker_log"
run_deploy "$public_env" --local --verify-only >/dev/null
assert_contains "$(cat "$docker_log")" "compose --env-file ${public_env} -f deploy/digitalocean/docker-compose.yml ps"

: > "$docker_log"
run_deploy "$protected_env" --local \
  --compose-overlay "$overlay_file" \
  --compose-overlay-env-file "$overlay_env" >/dev/null
assert_contains "$(cat "$docker_log")" "--env-file ${overlay_env} -f ${overlay_file} up -d --build --remove-orphans"
assert_contains "$(cat "$docker_log")" "--env-file ${overlay_env} -f ${overlay_file} up -d --force-recreate --no-deps caddy"

: > "$docker_log"
if run_deploy "$protected_env" --local >"${temp_dir}/guard.out" 2>&1; then
  echo "expected a public-only deploy after overlay activation to fail" >&2
  exit 1
fi
assert_contains "$(cat "${temp_dir}/guard.out")" "no Compose overlay was supplied"
[ ! -s "$docker_log" ] || { echo "guard invoked docker before failing" >&2; exit 1; }

: > "$docker_log"
run_deploy "$protected_env" --verify-only --target test-host --dir "$repo_root" \
  --compose-overlay "$overlay_file" \
  --compose-overlay-env-file "$overlay_env" >/dev/null
assert_contains "$(cat "$docker_log")" "--env-file ${overlay_env} -f ${overlay_file} ps"

special_overlay="${temp_dir}/overlay with spaces & symbols.yml"
special_env="${temp_dir}/env with spaces & symbols.env"
cp "$overlay_file" "$special_overlay"
cp "$overlay_env" "$special_env"
: > "$docker_log"
run_deploy "$protected_env" --verify-only --target test-host --dir "$repo_root" \
  --compose-overlay "$special_overlay" \
  --compose-overlay-env-file "$special_env" >/dev/null
assert_contains "$(cat "$docker_log")" "--env-file ${special_env} -f ${special_overlay} ps"

echo "deploy-production overlay tests passed"
