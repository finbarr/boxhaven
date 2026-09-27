#!/usr/bin/env python3
"""Record immutable artifacts and wire protocols for a coordinated release."""
import argparse
import json
from pathlib import Path
import re
import subprocess


def manifest(tag, digest, root):
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag) or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        raise ValueError('Expected stable core tag and sha256 image digest')
    protocol = (root / 'backend/src/compatibility.ts').read_text()
    api = int(re.search(r'export const apiProtocol = (\d+);', protocol)[1])
    runtime = int(re.search(r'export const runtimeProtocol = (\d+);', protocol)[1])
    desktop = json.loads((root / 'desktop/package.json').read_text())['version']
    return {'schema_version': 1, 'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
            'core_version': tag, 'cli_version': tag, 'backend_image': 'ghcr.io/finbarr/boxhaven-backend@' + digest,
            'desktop_version': desktop, 'desktop_tag': 'desktop-v' + desktop,
            'api_protocol': api, 'runtime_protocol': runtime,
            'runtime_image_policy': 'New boxes use the configured golden image. Existing VMs are unchanged.',
            'cli_platforms': ['darwin/amd64', 'darwin/arm64', 'linux/amd64', 'linux/arm64'],
            'desktop_platforms': ['darwin/arm64'], 'backend_platforms': ['linux/amd64', 'linux/arm64']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('tag')
    parser.add_argument('digest')
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    args.output.write_text(json.dumps(manifest(args.tag, args.digest, Path(__file__).resolve().parents[1]), indent=2) + '\n')
