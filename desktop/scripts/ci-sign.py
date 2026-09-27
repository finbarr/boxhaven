#!/usr/bin/env python3
"""Import ephemeral signing credentials, run release, then remove all key material."""
import base64
import os
from pathlib import Path
import secrets
import re
import shlex
import subprocess
import tempfile

required = ('APPLE_CERTIFICATE_BASE64', 'APPLE_CERTIFICATE_PASSWORD',
            'APPLE_ID', 'APPLE_ID_PASSWORD', 'APPLE_TEAM_ID')
missing = [name for name in required if not os.environ.get(name)]
if missing:
    raise SystemExit('Missing GitHub Actions secrets: ' + ', '.join(missing))

def quiet(*args):
    # Apple's commands can echo credential inputs on failure. Do not forward output.
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError(f'{args[0]} {args[1]} failed (output withheld to protect credentials)')
    return result.stdout.decode()

previous = shlex.split(quiet('security', 'list-keychains', '-d', 'user'))
with tempfile.TemporaryDirectory(prefix='boxhaven-sign-', dir=os.environ.get('RUNNER_TEMP')) as temp:
    folder = Path(temp)
    keychain = str(folder / 'release.keychain-db')
    cert = folder / 'signing.p12'
    cert.write_bytes(base64.b64decode(''.join(os.environ['APPLE_CERTIFICATE_BASE64'].split()), validate=True))
    cert.chmod(0o600)
    password = secrets.token_urlsafe(32)
    created = False
    try:
        quiet('security', 'create-keychain', '-p', password, keychain)
        created = True
        quiet('security', 'set-keychain-settings', '-lut', '21600', keychain)
        quiet('security', 'unlock-keychain', '-p', password, keychain)
        quiet('security', 'import', str(cert), '-k', keychain, '-P', os.environ['APPLE_CERTIFICATE_PASSWORD'], '-T', '/usr/bin/codesign')
        quiet('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychain)
        quiet('security', 'list-keychains', '-d', 'user', '-s', keychain, *previous)
        identities = quiet('security', 'find-identity', '-v', '-p', 'codesigning', keychain)
        matches = re.findall(r'"(Developer ID Application: [^"]+)"', identities)
        matches = [identity for identity in matches if identity.endswith('(' + os.environ['APPLE_TEAM_ID'] + ')')]
        if len(matches) != 1:
            raise RuntimeError('Expected exactly one valid Developer ID Application identity for APPLE_TEAM_ID')
        quiet('xcrun', 'notarytool', 'store-credentials', 'boxhaven-release', '--keychain', keychain,
              '--apple-id', os.environ['APPLE_ID'], '--password', os.environ['APPLE_ID_PASSWORD'],
              '--team-id', os.environ['APPLE_TEAM_ID'])
        env = {k: v for k, v in os.environ.items() if k not in required}
        env.update(APPLE_SIGN_IDENTITY=matches[0], BOXHAVEN_SIGN_KEYCHAIN=keychain, BOXHAVEN_NOTARY_PROFILE='boxhaven-release')
        subprocess.run(['npm', '--prefix', 'desktop', 'run', 'release'], env=env, check=True)
    finally:
        try:
            quiet('security', 'list-keychains', '-d', 'user', '-s', *previous)
        finally:
            if created:
                quiet('security', 'delete-keychain', keychain)
