// Verify the downloaded release, then exercise the app copied out of its DMG.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'darwin', 'DMG verification requires macOS.');
assert.ok(process.argv[2], 'Usage: node desktop/scripts/smoke-dmg.mjs path/to/BoxHaven.dmg');
const dmg = resolve(process.argv[2]);
const checksum = readFileSync(`${dmg}.sha256`, 'utf8').trim();
const digest = createHash('sha256').update(readFileSync(dmg)).digest('hex');
assert.equal(checksum, `${digest}  ${basename(dmg)}`, 'Downloaded DMG checksum mismatch');
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
run('codesign', ['--verify', '--strict', dmg]);
run('xcrun', ['stapler', 'validate', dmg]);
run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', dmg]);
const temp = mkdtempSync(join(tmpdir(), 'boxhaven-dmg-smoke-'));
const mount = join(temp, 'mounted');
const app = join(temp, 'BoxHaven.app');
let mounted = false;
try {
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]);
  mounted = true;
  assert.equal(readlinkSync(join(mount, 'Applications')), '/Applications');
  run('ditto', [join(mount, 'BoxHaven.app'), app]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  run('xcrun', ['stapler', 'validate', app]);
  run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  run(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'smoke-package.mjs'), app]);
  if (process.argv.includes('--remote')) {
    run(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'smoke-remote.mjs'), '--app', app]);
  }
  console.log('Downloaded DMG checksum, signatures, notarization tickets, install layout, and packaged app passed.');
} finally {
  // Do not remove a mount point's contents if detaching fails.
  if (mounted) run('hdiutil', ['detach', mount]);
  rmSync(temp, { recursive: true, force: true });
}
