#!/usr/bin/env python3
"""Release one verified source revision across core, desktop, and Homebrew."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
REPO = 'finbarr/boxhaven'


def run(args, cwd=ROOT, capture=False, env=None):
    return subprocess.run([str(a) for a in args], cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None, env=env).stdout


def git(*args, cwd=ROOT):
    return run(['git', *args], cwd=cwd, capture=True).strip()


def clean(root, branch):
    if git('status', '--porcelain', cwd=root) or git('branch', '--show-current', cwd=root) != branch:
        raise RuntimeError(f'{root} must be clean on {branch}')
    run(['git', 'fetch', '--tags', 'origin', branch], cwd=root)
    sha = git('rev-parse', 'HEAD', cwd=root)
    if sha != git('rev-parse', 'origin/' + branch, cwd=root):
        raise RuntimeError(f'{root} must match origin/{branch}')
    return sha


def wait(workflow, sha, branch):
    deadline = time.monotonic() + 5400
    while time.monotonic() < deadline:
        rows = json.loads(run(['gh', 'run', 'list', '--repo', REPO, '--workflow', workflow,
            '--commit', sha, '--branch', branch, '--event', 'push', '--limit', '1',
            '--json', 'status,conclusion,url'], capture=True))
        if rows and rows[0]['status'] == 'completed':
            if rows[0]['conclusion'] != 'success':
                raise RuntimeError('Workflow failed: ' + rows[0]['url'])
            print('Verified ' + rows[0]['url'], flush=True)
            return
        print(f'Waiting for {workflow} ({branch})...', flush=True)
        time.sleep(20)
    raise RuntimeError('Timed out waiting for ' + workflow)


def ensure_tags(tags, sha):
    for tag in tags:
        existing = git('tag', '--list', tag)
        if existing and git('rev-parse', tag + '^{commit}') != sha:
            raise RuntimeError(f'{tag} already points elsewhere; never move release tags')
    for tag in tags:
        if not git('tag', '--list', tag):
            run(['git', 'tag', '-a', tag, '-m', tag])
    run(['git', 'push', '--atomic', 'origin', *['refs/tags/' + t for t in tags]])


def validate_manifest(value, tag, desktop, sha):
    expected = {'core_version': tag, 'cli_version': tag, 'desktop_version': desktop,
                'desktop_tag': 'desktop-v' + desktop, 'source_commit': sha, 'api_protocol': 1, 'runtime_protocol': 1}
    if any(value.get(k) != v for k, v in expected.items()):
        raise RuntimeError('Release manifest does not match the coordinated source and versions')
    if not re.fullmatch(r'ghcr.io/finbarr/boxhaven-backend@sha256:[0-9a-f]{64}', value.get('backend_image', '')):
        raise RuntimeError('Missing immutable backend image digest')


def update_tap(tag, temp):
    run(['brew', 'tap', 'finbarr/tap'])
    tap = Path(run(['brew', '--repo', 'finbarr/tap'], capture=True).strip())
    clean(tap, 'main')
    run(['gh', 'release', 'download', tag, '--repo', REPO, '--pattern', 'SHA256SUMS', '--dir', temp])
    formula = tap / 'Formula/boxhaven.rb'
    run(['scripts/render-homebrew-formula.sh', tag, temp / 'SHA256SUMS', formula])
    run(['git', 'diff', '--check'], cwd=tap)
    env = {**os.environ, 'HOMEBREW_NO_AUTO_UPDATE': '1'}
    for args in [['audit', '--strict', '--online'], ['fetch', '--force'], ['reinstall'], ['test']]:
        run(['brew', *args, 'finbarr/tap/boxhaven'], env=env)
    binary = Path(run(['brew', '--prefix', 'boxhaven'], capture=True).strip()) / 'bin/bh'
    if not run([binary, 'version'], capture=True).startswith(f'bh {tag} ('):
        raise RuntimeError('Homebrew installed the wrong release')
    if git('status', '--porcelain', cwd=tap):
        run(['git', 'add', 'Formula/boxhaven.rb'], cwd=tap)
        run(['git', 'commit', '-m', f'Update boxhaven to {tag[1:]}'], cwd=tap)
        run(['git', 'push', 'origin', 'HEAD:main'], cwd=tap)
    live = run(['gh', 'api', 'repos/finbarr/homebrew-tap/contents/Formula/boxhaven.rb?ref=main',
                '-H', 'Accept: application/vnd.github.raw+json'], capture=True)
    if live != formula.read_text():
        raise RuntimeError('Published tap does not match verified formula')


def verify_desktop(desktop, core, temp):
    directory = temp / 'desktop'
    directory.mkdir()
    run(['gh', 'release', 'download', 'desktop-v' + desktop, '--repo', REPO, '--dir', directory])
    names = {f'BoxHaven-{desktop}-mac-arm64.{ext}' for ext in ('zip', 'dmg')}
    if {p.name for p in directory.iterdir()} != names | {n + '.sha256' for n in names}:
        raise RuntimeError('Unexpected desktop artifact inventory')
    for name in names:
        expected = (directory / (name + '.sha256')).read_text().strip()
        if expected != hashlib.sha256((directory / name).read_bytes()).hexdigest() + '  ' + name:
            raise RuntimeError('Desktop checksum mismatch')
    run(['ditto', '-x', '-k', directory / f'BoxHaven-{desktop}-mac-arm64.zip', directory])
    bundle = directory / 'BoxHaven.app'
    run(['codesign', '--verify', '--deep', '--strict', bundle])
    run(['xcrun', 'stapler', 'validate', bundle])
    actual = run([bundle / 'Contents/Resources/app/bin/bh', 'version'], capture=True)
    if not actual.startswith(f'bh {core} ('):
        raise RuntimeError('Desktop bundles a different CLI revision')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('version', help='New core tag, e.g. v0.4.0')
    parser.add_argument('--check', action='store_true', help='Validate source and prerequisites without publishing')
    args = parser.parse_args()
    try:
        if not re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', args.version):
            raise RuntimeError('Expected vX.Y.Z')
        for tool in ('git', 'gh', 'go', 'brew', 'docker', 'ditto', 'codesign', 'xcrun'):
            if not shutil.which(tool):
                raise RuntimeError('Missing release prerequisite: ' + tool + ' (run on macOS)')
        sha = clean(ROOT, 'master')
        desktop = json.loads((ROOT / 'desktop/package.json').read_text())['version']
        tags = [args.version, 'desktop-v' + desktop]
        for tag in tags:
            if git('tag', '--list', tag) and git('rev-parse', tag + '^{commit}') != sha:
                raise RuntimeError(f'{tag} exists at a different commit; bump the version')
        cores = [tuple(map(int, t[1:].split('.'))) for t in git('tag', '--list', 'v*').splitlines() if re.fullmatch(r'v\d+\.\d+\.\d+', t)]
        if cores and tuple(map(int, args.version[1:].split('.'))) < max(cores):
            raise RuntimeError('Refusing to release an older core version')
        run(['gh', 'auth', 'status'])
        run(['docker', 'info'], capture=True)
        with tempfile.TemporaryDirectory(prefix='boxhaven-release-') as directory:
            temp = Path(directory)
            run(['scripts/check-release-metadata.sh', args.version, temp / 'notes.md'])
            if args.check:
                print(f'Ready to verify and publish {args.version} + desktop {desktop} from {sha}.'); return
            wait('ci.yml', sha, 'master')
            if clean(ROOT, 'master') != sha:
                raise RuntimeError('Source changed while waiting for CI')
            ensure_tags(tags, sha)
            wait('release.yml', sha, args.version)
            wait('desktop-release.yml', sha, tags[1])
            run(['scripts/verify-published-release.sh', args.version])
            run(['gh', 'release', 'download', args.version, '--repo', REPO, '--pattern', 'release-manifest.json', '--dir', temp])
            manifest = json.loads((temp / 'release-manifest.json').read_text())
            validate_manifest(manifest, args.version, desktop, sha)
            # Consumers must be able to pull without maintainer credentials.
            empty_config = temp / 'docker-config'
            empty_config.mkdir()
            run(['docker', '--config', empty_config, 'pull', manifest['backend_image']])
            verify_desktop(desktop, args.version, temp)
            update_tap(args.version, temp)
            run(['gh', 'release', 'edit', tags[1], '--repo', REPO, '--draft=false', '--latest=false'])
        print(f'Released {args.version}, desktop {desktop}, immutable backend image, and tested Homebrew formula. Hosted production deployment is separate.')
    except (RuntimeError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'release: {error}\n')


if __name__ == '__main__':
    main()
