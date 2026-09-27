const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestDesktop } = require('../src/updater.cjs');
const release = { tag_name: 'desktop-v0.2.0', assets: [{ name: 'BoxHaven-0.2.0-mac-arm64.zip', browser_download_url: 'https://github.com/finbarr/boxhaven/releases/download/desktop-v0.2.0/BoxHaven-0.2.0-mac-arm64.zip' }] };
test('desktop updates select their own signed release stream and refuse replacement URLs', () => {
  const mixed = [{ tag_name: 'v9.0.0' }, { ...release, draft: true }, { ...release, prerelease: true }];
  assert.equal(latestDesktop(mixed, '0.1.0', 'arm64'), null);
  assert.equal(latestDesktop([...mixed, release], '0.1.0', 'arm64').version, '0.2.0');
  assert.equal(latestDesktop([release], '0.2.0', 'arm64'), null);
  assert.equal(latestDesktop([release], '0.3.0', 'arm64'), null);
  assert.throws(() => latestDesktop([release], '0.1.0', 'x64'));
  assert.throws(() => latestDesktop([{ ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://attacker.example/app.zip' }] }], '0.1.0', 'arm64'));
});
const { EventEmitter } = require('node:events');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createUpdater } = require('../src/updater.cjs');
test('download prompts defer safely and restart only after pending operations', { skip: process.platform !== 'darwin' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bh-updater-test-'));
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '0.1.0', getPath: () => dir });
  const native = new EventEmitter(); let checked = 0, restarted = 0, ready = false, response = 1;
  native.setFeedURL = feed => { assert.match(feed.url, /^file:/); assert.equal(feed.serverType, 'json'); };
  native.checkForUpdates = () => { checked++; };
  native.quitAndInstall = () => { assert.equal(ready, true); restarted++; };
  const updater = createUpdater({ app, autoUpdater: native, getWindow: () => null,
    dialog: { showMessageBox: async () => ({ response }) }, readyToRestart: async () => { ready = true; },
    fetcher: async () => new Response(JSON.stringify([release])),
  });
  try {
    await updater.check(true); await updater.check(true); assert.equal(checked, 1);
    assert.equal(JSON.parse(readFileSync(join(dir, 'desktop-updates.json'))).currentRelease, '0.2.0');
    native.emit('update-downloaded'); await new Promise(resolve => setImmediate(resolve)); assert.equal(restarted, 0);
    response = 0; await updater.check(true); assert.equal(restarted, 1);
  } finally { app.emit('before-quit'); rmSync(dir, { recursive: true, force: true }); }
});
