#!/usr/bin/env python3
"""Verify public update artifacts and the live installation documentation."""
import argparse
import json
from pathlib import Path
import re
from urllib.request import Request, urlopen


def read(url):
    with urlopen(Request(url, headers={'User-Agent': 'boxhaven-release-smoke'}), timeout=30) as response:
        return response.read().decode()


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--core-version', required=True)
parser.add_argument('--docs-url', default='https://docs.boxhaven.dev')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
desktop = json.loads((root / 'desktop/package.json').read_text())['version']
api = 'https://api.github.com/repos/finbarr/boxhaven/releases/'
core = json.loads(read(api + 'tags/' + args.core_version))
app = json.loads(read(api + 'tags/desktop-v' + desktop))
assert not core['draft'] and not app['draft']
assert json.loads(read(api + 'latest'))['tag_name'] == args.core_version
assets = {asset['name']: asset for asset in core['assets']}
manifest = json.loads(read(assets['release-manifest.json']['browser_download_url']))
assert manifest['core_version'] == manifest['cli_version'] == args.core_version
assert manifest['desktop_version'] == desktop
assert re.fullmatch(r'ghcr.io/finbarr/boxhaven-backend@sha256:[0-9a-f]{64}', manifest['backend_image'])
for path, expected in [('/desktop', f'/desktop-v{desktop}/BoxHaven-{desktop}-mac-arm64.dmg'),
                       ('/commands', 'bh upgrade'), ('/self-hosting', 'upgrade:backend')]:
    assert expected in read(args.docs_url.rstrip('/') + path), f'Missing {expected} from {path}'
print(f'Public core {args.core_version}, desktop {desktop}, manifest, latest pointer, and live update docs passed.')
