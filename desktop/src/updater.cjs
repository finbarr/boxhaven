const { join } = require('node:path');
const { writeFile, rename } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const releasesURL = 'https://api.github.com/repos/finbarr/boxhaven/releases?per_page=100';
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
function latestDesktop(releases, current, arch) {
  if (!Array.isArray(releases)) throw new Error('Invalid release response');
  const candidates = releases.filter(r => !r.draft && !r.prerelease && /^desktop-v\d+\.\d+\.\d+$/.test(r.tag_name || ''));
  candidates.sort((a, b) => compare(b.tag_name.slice(9), a.tag_name.slice(9)));
  const release = candidates[0];
  if (!release || compare(release.tag_name.slice(9), current) <= 0) return null;
  const version = release.tag_name.slice(9);
  const name = `BoxHaven-${version}-mac-${arch}.zip`;
  const asset = release.assets?.find(a => a.name === name);
  const url = `https://github.com/finbarr/boxhaven/releases/download/${release.tag_name}/${name}`;
  if (!asset || asset.browser_download_url !== url) throw new Error('The desktop release has no verified update archive for this Mac');
  return { version, url, name: `BoxHaven ${version}`, notes: 'Your remote boxes keep running while BoxHaven restarts.', pub_date: release.published_at };
}
function createUpdater({ app, autoUpdater, dialog, getWindow, readyToRestart, fetcher = fetch }) {
  let checking = false, manual = false, downloaded = false, timer;
  const show = options => { const window = getWindow(); return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options); };
  const restart = async () => { await readyToRestart(); autoUpdater.quitAndInstall(); };
  autoUpdater.on('error', () => { checking = false; if (manual) void show({ type: 'error', message: 'Could not update BoxHaven', detail: 'Your installed version is unchanged. Check your connection and try again.' }); manual = false; });
  autoUpdater.on('update-not-available', () => { checking = false; manual = false; });
  async function offerRestart() {
    const { response } = await show({ type: 'info', message: 'BoxHaven is ready to update', detail: 'Restart to install. Your remote boxes and sessions keep running.', buttons: ['Restart to update', 'Later'], defaultId: 1, cancelId: 1 });
    if (response === 0) await restart();
  }
  autoUpdater.on('update-downloaded', async () => {
    checking = false; downloaded = true; manual = false;
    await offerRestart();
  });
  async function check(userInitiated = false) {
    if (!app.isPackaged || process.platform !== 'darwin') {
      if (userInitiated) await show({ message: 'Updates are available in the installed macOS app.' });
      return;
    }
    if (downloaded) { if (userInitiated) await offerRestart(); return; }
    if (checking) return;
    checking = true; manual = userInitiated;
    try {
      const response = await fetcher(releasesURL, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('Release request failed');
      const update = latestDesktop(await response.json(), app.getVersion(), process.arch);
      if (!update) {
        checking = false; manual = false;
        if (userInitiated) await show({ message: 'BoxHaven is up to date', detail: `Version ${app.getVersion()}` });
        return;
      }
      const feed = join(app.getPath('userData'), 'desktop-updates.json');
      await writeFile(`${feed}.tmp`, JSON.stringify({ currentRelease: update.version, releases: [{ version: update.version, updateTo: update }] }), { mode: 0o600 });
      await rename(`${feed}.tmp`, feed);
      autoUpdater.setFeedURL({ url: pathToFileURL(feed).href, serverType: 'json' });
      // Squirrel validates the new app's Developer ID signature before replacement.
      autoUpdater.checkForUpdates();
    } catch {
      checking = false;
      if (userInitiated) await show({ type: 'error', message: 'Could not check for updates', detail: 'Your installed version is unchanged. Try again later.' });
      manual = false;
    }
  }
  if (app.isPackaged && process.platform === 'darwin') {
    timer = setInterval(() => void check(), 10 * 60 * 1000); timer.unref();
    const initial = setTimeout(() => void check(), 15000); initial.unref();
    app.once('before-quit', () => { clearInterval(timer); clearTimeout(initial); });
  }
  return { check };
}
module.exports = { createUpdater, latestDesktop };
