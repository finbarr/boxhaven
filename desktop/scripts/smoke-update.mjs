// Exercise Apple's native signed-app updater on a disposable installation.
import { _electron as electron } from 'playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const [base, target, version] = process.argv.slice(2);
assert.ok(base && target && /^\d+\.\d+\.\d+$/.test(version), 'Usage: smoke-update.mjs old.dmg new.zip new-version');
const zip = resolve(target), dmg = resolve(base);
for (const asset of [zip, dmg]) assert.equal(readFileSync(`${asset}.sha256`, 'utf8').trim(), `${createHash('sha256').update(readFileSync(asset)).digest('hex')}  ${basename(asset)}`);
const temp = mkdtempSync(join(tmpdir(), 'boxhaven-native-update-'));
const mount = join(temp, 'mount'), bundle = join(temp, 'BoxHaven.app');
const run = (command, args) => execFileSync(command, args, { stdio: 'pipe' });
let app, mounted = false;
const server = createServer((req, res) => { if (req.url !== '/update.zip') { res.writeHead(404).end(); return; } res.setHeader('Content-Type', 'application/zip'); createReadStream(zip).pipe(res); });
try {
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, dmg]); mounted = true;
  run('ditto', [join(mount, 'BoxHaven.app'), bundle]);
  run('codesign', ['--verify', '--deep', '--strict', bundle]);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const feed = join(temp, 'releases.json');
  writeFileSync(feed, JSON.stringify({ currentRelease: version, releases: [{ version, updateTo: { version, url: `http://127.0.0.1:${server.address().port}/update.zip`, name: 'BoxHaven smoke update', pub_date: new Date().toISOString(), notes: 'Disposable native update verification' } }] }));
  app = await electron.launch({ executablePath: join(bundle, 'Contents/MacOS/BoxHaven'), args: [`--user-data-dir=${join(temp, 'profile')}`], env: { ...process.env, XDG_CONFIG_HOME: temp, BOXHAVEN_TOKEN: '', BOXHAVEN_BACKEND_URL: '' } });
  await app.firstWindow();
  await app.evaluate(({ autoUpdater }, feedURL) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Native update download timed out')), 120000);
    autoUpdater.once('error', error => { clearTimeout(timeout); reject(error); });
    autoUpdater.once('update-downloaded', () => { clearTimeout(timeout); resolve(true); });
    autoUpdater.setFeedURL({ url: feedURL, serverType: 'json' }); autoUpdater.checkForUpdates();
  }), pathToFileURL(feed).href);
  console.log('Native updater downloaded and validated the signed update.');
  await app.evaluate(({ autoUpdater }) => { setTimeout(() => autoUpdater.quitAndInstall(), 100); });
  let installed = false;
  for (let i = 0; i < 120; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try { installed = JSON.parse(readFileSync(join(bundle, 'Contents/Resources/app/package.json'))).version === version; } catch {}
    if (installed) break;
  }
  assert.ok(installed, 'Native updater did not replace the app');
  run('codesign', ['--verify', '--deep', '--strict', bundle]);
  run('xcrun', ['stapler', 'validate', bundle]);
  console.log(`Native signed-app replacement passed: ${version}.`);
} finally {
  try { await app?.close(); } catch {}
  // Squirrel relaunches the disposable app. Stop only processes inside this temp bundle.
  const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of processes.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match && match[2].includes(bundle)) { try { process.kill(Number(match[1]), 'SIGTERM'); } catch {} }
  }
  server.close();
  if (mounted) run('hdiutil', ['detach', mount]);
  // Signed release bundles are read-only; make this disposable copy removable.
  run("chmod", ["-R", "u+w", temp]);
  try { rmSync(temp, { recursive: true, force: true }); }
  catch (error) {
    if (error.code !== "EACCES") throw error;
    console.warn(`Update passed; Squirrel left root-owned test directories at ${temp}. Remove these with administrator privileges.`);
  }
}
