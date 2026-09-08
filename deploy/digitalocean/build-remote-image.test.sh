#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
mkdir -p "$temp_dir/bin"
export TEST_IMAGE_STATE="$temp_dir/images.json"
export TEST_BUILDER_DELETED="$temp_dir/builder-deleted"
cat > "$TEST_IMAGE_STATE" <<'JSON'
[
  {"id":"100","name":"boxhaven-remote-previous-golden","created_at":"2026-09-01T00:00:00Z"},
  {"id":"101","name":"boxhaven-remote-team-project","created_at":"2026-08-01T00:00:00Z"},
  {"id":"102","name":"boxhaven-remote-new-build","created_at":"2026-09-08T00:00:00Z"}
]
JSON
cp "$TEST_IMAGE_STATE" "$temp_dir/expected-images.json"
cat > "$temp_dir/bin/curl" <<'PY'
#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

args = sys.argv[1:]
method = args[args.index('-X') + 1]
output = Path(args[args.index('-o') + 1])
path = urlparse(args[-1]).path
state = Path(os.environ['TEST_IMAGE_STATE'])
images = json.loads(state.read_text())
status = 200
if method == 'POST' and path == '/v2/droplets':
    body = json.loads(args[args.index('-d') + 1])
    assert body['image'] == 100, 'builder must start from the active golden image'
    response = {'droplet': {'id': 900}}
elif method == 'GET' and path == '/v2/droplets/900':
    response = {'droplet': {'status': 'off', 'networks': {'v4': [{'type': 'public', 'ip_address': '192.0.2.1'}]}}}
elif method == 'POST' and path == '/v2/droplets/900/actions':
    response = {'action': {'id': 901}}
elif method == 'GET' and path == '/v2/droplets/900/actions/901':
    response = {'action': {'status': 'completed'}}
elif method == 'GET' and path == '/v2/snapshots':
    response = {'snapshots': images}
elif method == 'DELETE' and path.startswith('/v2/images/'):
    state.write_text(json.dumps([image for image in images if image['id'] != path.rsplit('/', 1)[1]]))
    response = {}
elif method == 'DELETE' and path == '/v2/droplets/900':
    Path(os.environ['TEST_BUILDER_DELETED']).touch()
    response = {}
else:
    raise AssertionError(f'unexpected request: {method} {path}')
output.write_text(json.dumps(response))
print(status, end='')
PY
cat > "$temp_dir/bin/ssh" <<'SH'
#!/usr/bin/env bash
cat >/dev/null
SH
cat > "$temp_dir/bin/rsync" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$temp_dir/bin/"*
cat > "$temp_dir/env" <<'ENV'
DIGITALOCEAN_ACCESS_TOKEN=fixture-only
DIGITALOCEAN_SSH_KEYS=1
BOXHAVEN_REMOTE_IMAGE=100
BOXHAVEN_DIGITALOCEAN_API_URL=https://provider.invalid
ENV

PATH="$temp_dir/bin:$PATH" "$script_dir/build-remote-image.sh" \
  --env-file "$temp_dir/env" --ref master \
  --name boxhaven-remote-new-build --set-active </dev/null >/dev/null
cmp "$temp_dir/expected-images.json" "$TEST_IMAGE_STATE"
test -f "$TEST_BUILDER_DELETED"
grep -Fxq 'BOXHAVEN_REMOTE_IMAGE=102' "$temp_dir/env"
echo 'image rebuild preserves existing snapshots and cleans up only its builder'
