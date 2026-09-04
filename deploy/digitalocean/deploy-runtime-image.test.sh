#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin" "$temp_dir/remote/deploy/digitalocean"

cat > "$temp_dir/bin/ssh" <<'EOF'
#!/usr/bin/env bash
shift 2 # -A and the test host
test "$1" = 'bash -s'
shift
exec bash -s "$@"
EOF
cat > "$temp_dir/bin/git" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = symbolic-ref ]; then printf 'master\n'; fi
EOF
cat > "$temp_dir/remote/deploy/digitalocean/build-remote-image.sh" <<'EOF'
#!/usr/bin/env bash
# An ordinary nested SSH command consumes inherited stdin unless redirected.
cat > "$TEST_BUILD_STDIN"
printf 'built\n' >> "$TEST_RUNTIME_EVENTS"
EOF
cat > "$temp_dir/remote/deploy/digitalocean/deploy-production.sh" <<'EOF'
#!/usr/bin/env bash
printf 'activated\n' >> "$TEST_RUNTIME_EVENTS"
EOF
chmod +x "$temp_dir/bin/ssh" "$temp_dir/bin/git" "$temp_dir/remote/deploy/digitalocean/"*.sh

PATH="$temp_dir/bin:$PATH" \
TEST_BUILD_STDIN="$temp_dir/build-stdin" \
TEST_RUNTIME_EVENTS="$temp_dir/events" \
  "$script_dir/deploy-runtime-image.sh" --target test-host --dir "$temp_dir/remote" >/dev/null

if [ "$(cat "$temp_dir/events")" != $'built\nactivated' ]; then
  echo 'runtime deploy did not activate the backend after building the image' >&2
  exit 1
fi
test ! -s "$temp_dir/build-stdin"
echo 'runtime image deploy preserves the activation command after nested SSH'
