import { packageApp } from './package.mjs';
import { releaseConfig, artifactName } from './release-config.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(readFileSync(join(root, 'package.json')));
const signing = releaseConfig(process.env, version);
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
const [output] = await packageApp(signing);
const app = join(output, 'BoxHaven.app');
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
for (const binary of ['Contents/Resources/app/bin/bh', 'Contents/Resources/app/node_modules/node-pty/build/Release/pty.node', 'Contents/Resources/app/node_modules/node-pty/build/Release/spawn-helper']) {
  run('codesign', ['--verify', '--strict', join(app, binary)]);
}
run('xcrun', ['stapler', 'validate', app]);
run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
// Execute the exact packaged CLI and native PTY before distributing the bundle.
run(process.execPath, [join(root, 'scripts/smoke-package.mjs'), app]);
const staging = mkdtempSync(join(tmpdir(), 'boxhaven-dmg-'));
const artifacts = join(root, 'release', 'artifacts');
mkdirSync(artifacts, { recursive: true });
const name = artifactName(version);
const dmg = join(artifacts, name);
try {
  run('ditto', [app, join(staging, 'BoxHaven.app')]);
  symlinkSync('/Applications', join(staging, 'Applications'));
  run('hdiutil', ['create', '-volname', 'BoxHaven', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg]);
  run('codesign', ['--sign', process.env.APPLE_SIGN_IDENTITY, '--keychain', process.env.BOXHAVEN_SIGN_KEYCHAIN, '--timestamp', dmg]);
  run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', process.env.BOXHAVEN_NOTARY_PROFILE, '--keychain', process.env.BOXHAVEN_SIGN_KEYCHAIN, '--wait']);
  run('xcrun', ['stapler', 'staple', dmg]);
  run('xcrun', ['stapler', 'validate', dmg]);
  run('codesign', ['--verify', '--strict', dmg]);
  run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
  const zipName = `BoxHaven-${version}-mac-arm64.zip`;
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, join(artifacts, zipName)]);
  for (const asset of [name, zipName]) {
    const digest = createHash('sha256').update(readFileSync(join(artifacts, asset))).digest('hex');
    writeFileSync(join(artifacts, `${asset}.sha256`), `${digest}  ${asset}\n`);
  }
  console.log(`Verified signed and notarized release: ${name}`);
} finally { rmSync(staging, { recursive: true, force: true }); }
