#!/usr/bin/env python3
"""Exercise real core containers, a migration, failed health, and explicit restore."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('upgrade', ROOT / 'scripts/upgrade-backend.py')
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)
run, output = upgrade.run, upgrade.output


def main():
    project = f'bh-upgrade-smoke-{os.getpid()}'
    tags = [f'{project}:{name}' for name in ('base', 'next', 'broken')]
    with tempfile.TemporaryDirectory(prefix='boxhaven-upgrade-smoke-') as tmp:
        temp = Path(tmp)
        config = temp / 'compose.json'
        state = temp / 'state'
        try:
            run('docker', 'build', '--build-arg', 'BOXHAVEN_VERSION=v0.4.0', '-t', tags[0], ROOT / 'backend')
            # A real schema change before the normal backend entry point.
            migration = "sqlite3 /data/boxhaven.sqlite 'CREATE TABLE upgrade_probe(value TEXT); INSERT INTO upgrade_probe VALUES (\"migrated\");'; exec npm start"
            (temp / 'Dockerfile').write_text(f'FROM {tags[0]}\nLABEL org.opencontainers.image.version="v0.4.1"\nENV BOXHAVEN_VERSION=v0.4.1\nCMD ' + json.dumps(['sh', '-ec', migration]) + '\n')
            run('docker', 'build', '-t', tags[1], temp)
            (temp / 'Dockerfile').write_text(f'FROM {tags[1]}\nLABEL org.opencontainers.image.version="v0.4.2"\nENV BOXHAVEN_VERSION=v0.4.2\nCMD ["sh", "-c", "sleep 300"]\n')
            run('docker', 'build', '-t', tags[2], temp)
            config.write_text(json.dumps({'services': {'backend': {
                'image': tags[0], 'environment': {'BETTER_AUTH_SECRET': 'upgrade-smoke-not-a-real-secret-000000',
                    'DIGITALOCEAN_ACCESS_TOKEN': 'unused-smoke-token', 'RESEND_API_KEY': 'unused-smoke-token',
                    'BOXHAVEN_EMAIL_FROM': 'smoke@example.com', 'BOXHAVEN_SSH_CA_KEY': '/data/ssh_ca_ed25519'},
                'volumes': ['data:/data'], 'healthcheck': {'test': ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], 'interval': '1s', 'timeout': '2s', 'retries': 5}}}, 'volumes': {'data': {}}}))
            upgrade.compose(config, project, 'up', '-d')
            upgrade.health(config, project, 'v0.4.0')
            cid = upgrade.compose(config, project, 'ps', '-q', 'backend')
            ca = output('docker', 'exec', cid, 'cat', '/data/ssh_ca_ed25519.pub')
            output('docker', 'exec', cid, 'sqlite3', '/data/boxhaven.sqlite', 'CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ("before");')
            command = ['python3', ROOT / 'scripts/upgrade-backend.py', '--project', project, '--compose', config, '--state-dir', state]
            run(*command, '--image', tags[1])
            cid = upgrade.compose(state / 'active.json', project, 'ps', '-q', 'backend')
            assert output('docker', 'exec', cid, 'sqlite3', '/data/boxhaven.sqlite', 'SELECT value FROM preserved;') == 'before'
            assert output('docker', 'exec', cid, 'sqlite3', '/data/boxhaven.sqlite', 'SELECT value FROM upgrade_probe;') == 'migrated'
            assert output('docker', 'exec', cid, 'cat', '/data/ssh_ca_ed25519.pub') == ca
            first = next(state.glob('*/recovery.json')).parent
            # Explicitly demonstrate loss of later writes, retaining them separately.
            output('docker', 'exec', cid, 'sqlite3', '/data/boxhaven.sqlite', 'INSERT INTO preserved VALUES ("after");')
            denied = subprocess.run([str(a) for a in [*command, '--rollback', first]], capture_output=True)
            assert denied.returncode != 0 and b'--accept-data-loss' in denied.stderr
            run(*command, '--rollback', first, '--accept-data-loss')
            cid = upgrade.compose(state / 'active.json', project, 'ps', '-q', 'backend')
            assert output('docker', 'exec', cid, 'sqlite3', '/data/boxhaven.sqlite', 'SELECT value FROM preserved;') == 'before'
            assert output('docker', 'exec', cid, 'sqlite3', '/data/boxhaven.sqlite', "SELECT count(*) FROM sqlite_master WHERE name='upgrade_probe';") == '0'
            assert output('docker', 'exec', cid, 'cat', '/data/ssh_ca_ed25519.pub') == ca
            time.sleep(1)  # Distinct recovery directory.
            failed = subprocess.run([str(a) for a in [*command, '--image', tags[2], '--timeout', 5]], capture_output=True)
            assert failed.returncode != 0, 'Unhealthy version unexpectedly passed'
            newest = sorted(state.glob('*/recovery.json'))[-1].parent
            cid = upgrade.compose(newest / 'target.json', project, 'ps', '-aq', 'backend')
            assert not upgrade.inspect('container', cid)['State']['Running'], 'Failed backend should be stopped'
            run(*command, '--rollback', newest, '--accept-data-loss')
            assert (first / 'data.tar.gz').stat().st_mode & 0o777 == 0o600
            print('PASS: migration, data/CA preservation, explicit rollback, failed health recovery, and private backups.')
        finally:
            if config.exists():
                upgrade.compose(config, project, 'down', '--volumes', '--remove-orphans')
            subprocess.run(['docker', 'image', 'rm', *tags], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
