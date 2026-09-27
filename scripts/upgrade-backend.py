#!/usr/bin/env python3
"""Explicit, backed-up upgrades for the core Docker Compose distribution."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def output(*args):
    return run(*args, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout.decode().strip()


def private_json(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')
    path.chmod(0o600)


def inspect(kind, ref):
    return json.loads(output('docker', kind, 'inspect', ref))[0]


def compose(config, project, *args):
    return output('docker', 'compose', '-p', project, '-f', config, *args)


def health(config, project, version, timeout=120):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            cid = compose(config, project, 'ps', '-q', 'backend')
            info = inspect('container', cid)
            if info['State'].get('Health', {}).get('Status') == 'healthy':
                script = "fetch('http://127.0.0.1:8787/v1/compatibility').then(async r=>{if(!r.ok)throw Error(r.status);console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))"
                report = json.loads(output('docker', 'exec', cid, 'node', '-e', script))
                if report['backend_version'] != version or report['api_protocol'] != 1 or report['runtime_protocol'] != 1:
                    raise RuntimeError('Unexpected backend version or protocol')
                return
        except (subprocess.CalledProcessError, ValueError, KeyError):
            pass
        time.sleep(2)
    raise RuntimeError('Backend did not become healthy; stopped it. Inspect container logs and use rollback if needed.')


def backup(cid, image, path):
    # Backend must already be stopped. SQLite and CA are copied together.
    output('docker', 'run', '--rm', '--user', '0', '--volumes-from', cid + ':ro', image,
           'sh', '-ec', 'test -s /data/boxhaven.sqlite; test -s /data/ssh_ca_ed25519; test "$(sqlite3 /data/boxhaven.sqlite PRAGMA\\ quick_check)" = ok')
    with path.open('wb') as stream:
        run('docker', 'run', '--rm', '--user', '0', '--volumes-from', cid + ':ro', image,
            'tar', '-C', '/data', '-czf', '-', '.', stdout=stream, stderr=subprocess.PIPE)
    path.chmod(0o600)
    return hashlib.sha256(path.read_bytes()).hexdigest()


def upgrade(args):
    state = args.state_dir.resolve()
    state.mkdir(mode=0o700, parents=True, exist_ok=True)
    state.chmod(0o700)
    with (state / 'lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.rollback:
            return rollback(args, state)
        image = args.image or f'ghcr.io/finbarr/boxhaven-backend:{args.version}'
        if args.version and not re.fullmatch(r'v\d+\.\d+\.\d+', args.version):
            raise RuntimeError('Version must be vX.Y.Z')
        if not args.image:
            run('docker', 'pull', image)
        target = inspect('image', image)
        labels = target['Config'].get('Labels') or {}
        version = labels.get('org.opencontainers.image.version', '')
        if labels.get('dev.boxhaven.distribution') != 'core' or not re.fullmatch(r'v\d+\.\d+\.\d+', version):
            raise RuntimeError('Target must be a versioned core BoxHaven image; custom distributions require their own upgrade procedure')
        if args.version and version != args.version:
            raise RuntimeError('Image version differs from requested version')
        current_args = ['docker', 'compose', '-p', args.project]
        if args.env_file:
            current_args += ['--env-file', str(args.env_file.resolve())]
        for file in args.compose:
            current_args += ['-f', str(file.resolve())]
        active = state / 'active.json'
        if active.exists():
            current_args += ['-f', str(active)]
        config = json.loads(output(*current_args, 'config', '--format', 'json'))
        ids = output(*current_args, 'ps', '-q', 'backend').splitlines()
        if len(ids) != 1:
            raise RuntimeError('Expected exactly one running backend; start the core Compose stack first')
        cid = ids[0]
        current = inspect('container', cid)
        previous = inspect('image', current['Image'])
        if (previous['Config'].get('Labels') or {}).get('dev.boxhaven.distribution') != 'core':
            raise RuntimeError('Current backend is a custom or unlabelled distribution; refusing to replace its modules')
        if not any(m['Destination'] == '/data' for m in current['Mounts']):
            raise RuntimeError('Backend must persist /data in a volume or bind mount')
        if current['Image'] == target['Id']:
            print(f'Already running {version}.'); return
        saved = state / (time.strftime('%Y%m%dT%H%M%S') + f'-{time.time_ns() % 1_000_000_000:09d}')
        saved.mkdir(mode=0o700)
        old_config = json.loads(json.dumps(config))
        old_config['services']['backend']['image'] = current['Image']
        # Preserve the exact running environment, including auth keys, for recovery.
        old_config['services']['backend']['environment'] = dict(v.split('=', 1) for v in current['Config']['Env'])
        private_json(saved / 'previous.json', old_config)
        config['services']['backend']['image'] = target['Id']
        config['services']['backend'].setdefault('environment', {})['BOXHAVEN_VERSION'] = version
        private_json(saved / 'target.json', config)
        old_version = old_config['services']['backend']['environment'].get('BOXHAVEN_VERSION', 'dev')
        print(f'Backing up {old_version} before upgrading to {version}.', flush=True)
        output('docker', 'stop', '--time', '30', cid)
        try:
            digest = backup(cid, current['Image'], saved / 'data.tar.gz')
        except BaseException:
            run('docker', 'start', cid)
            raise
        private_json(saved / 'recovery.json', {'project': args.project, 'previous_version': old_version,
                     'version': version, 'sha256': digest, 'previous_image': current['Image'], 'target_image': target['Id']})
        try:
            compose(saved / 'target.json', args.project, 'up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'backend')
            health(saved / 'target.json', args.project, version, args.timeout)
        except BaseException:
            compose(saved / 'target.json', args.project, 'stop', 'backend')
            print(f'Upgrade failed. Recovery directory: {saved}', flush=True)
            raise
        private_json(active, config)
        print(f'Upgraded to {version}. Recovery directory: {saved}')


def rollback(args, state):
    if not args.accept_data_loss:
        raise RuntimeError('Rollback restores the pre-upgrade database. Use --accept-data-loss after preserving newer changes.')
    saved = args.rollback.resolve()
    manifest = json.loads((saved / 'recovery.json').read_text())
    if manifest['project'] != args.project:
        raise RuntimeError('Recovery belongs to a different Compose project')
    archive = saved / 'data.tar.gz'
    if hashlib.sha256(archive.read_bytes()).hexdigest() != manifest['sha256']:
        raise RuntimeError('Backup checksum mismatch; no changes made')
    previous = saved / 'previous.json'
    # Never accidentally roll back a different installation or a later upgrade.
    ids = compose(saved / 'target.json', args.project, 'ps', '-aq', 'backend').splitlines()
    if len(ids) != 1:
        raise RuntimeError('Expected one backend container to recover')
    cid = ids[0]
    if inspect('container', cid)['Image'] not in (manifest['target_image'], manifest['previous_image']):
        raise RuntimeError('Backend changed since this upgrade; refusing stale recovery')
    output('docker', 'stop', '--time', '30', cid)
    failed = saved / f'before-rollback-{time.time_ns()}.tar.gz'
    # Retain even a broken/migrated database for investigation; do not quick-check it.
    with failed.open('wb') as stream:
        run('docker', 'run', '--rm', '--user', '0', '--volumes-from', cid + ':ro', manifest['previous_image'],
            'tar', '-C', '/data', '-czf', '-', '.', stdout=stream, stderr=subprocess.PIPE)
    failed.chmod(0o600)
    with archive.open('rb') as stream:
        run('docker', 'run', '--rm', '-i', '--user', '0', '--volumes-from', cid, manifest['previous_image'],
            'sh', '-ec', 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; tar -C /data -xzf -', stdin=stream, stderr=subprocess.PIPE)
    compose(previous, args.project, 'up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'backend')
    try:
        health(previous, args.project, manifest['previous_version'], args.timeout)
    except BaseException:
        compose(previous, args.project, 'stop', 'backend')
        raise
    private_json(state / 'active.json', json.loads(previous.read_text()))
    print(f"Restored {manifest['previous_version']}; retained pre-rollback data at {failed}")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--version', help='Published core version, e.g. v0.4.0')
    target.add_argument('--image', help='Explicit already-pulled core image or digest')
    target.add_argument('--rollback', type=Path, help='Recovery directory printed by upgrade')
    parser.add_argument('--accept-data-loss', action='store_true')
    parser.add_argument('--compose', type=Path, action='append', default=[])
    parser.add_argument('--env-file', type=Path)
    parser.add_argument('--project', default='boxhaven')
    parser.add_argument('--state-dir', type=Path, default=Path('.boxhaven-upgrades'))
    parser.add_argument('--timeout', type=int, default=120)
    args = parser.parse_args()
    if not args.compose:
        args.compose = [Path('docker-compose.release.yml')]
    try:
        upgrade(args)
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        # Captured Docker output can contain resolved secrets; do not echo it.
        parser.exit(1, f'backend-upgrade: {error}\n')


if __name__ == '__main__':
    main()
